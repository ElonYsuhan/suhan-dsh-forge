/**
 * 工作项改动预览：验收时（以及执行中/完成后）查看本任务改了什么。
 *
 * 两种来源，统一渲染为独立 HTML 页：
 * - 任务 worktree 存续：diff 任务分支基线（baseCommit）到工作树，含 Agent 未提交改动；
 * - 已集成（commitRef）：diff 集成提交与其父提交，在主工作区进行。
 * 文件内容页：worktree 模式读磁盘，集成模式 `git show <commit>:<path>`（精确交付状态）。
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import process from 'node:process'
import { TextDecoder } from 'node:util'
import { HttpError } from './http.ts'
import type { Board, WorkItem } from './shared/types.ts'

/** git diff 在存在差异时退出码为 1：包装后始终返回原始字节与退出码，由调用方判断。 */
function execGit (cwd: string, args: string[]): Promise<{ stdout: Buffer; code: number }> {
  return new Promise(resolveResult => {
    execFile('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      env: process.env
    }, (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code
      resolveResult({ stdout, code: typeof code === 'number' ? code : 0 })
    })
  })
}

async function git (cwd: string, args: string[]): Promise<string> {
  const result = await execGit(cwd, args)
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`git ${args[0]} 失败（退出码 ${result.code}）`)
  }
  return result.stdout.toString('utf8')
}

/** 严格 UTF-8 解码；含 NUL 或非法序列视为二进制（与 git 的二进制判定一致）。 */
function decodeText (raw: Buffer): { content: string; binary: boolean } {
  if (raw.includes(0)) return { content: '', binary: true }
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(raw), binary: false }
  } catch {
    return { content: '', binary: true }
  }
}

/** git 空树常量：仓库首个提交的 diff 基。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

interface PreviewScope {
  /** 实际执行 git 的目录（worktree 或项目目录）。 */
  cwd: string
  /** diff 基线：worktree 模式=任务分支基线提交；集成模式=集成提交的父提交。 */
  base: string
  /** 集成模式的提交；worktree 模式为 undefined（diff 到工作树）。 */
  head?: string | undefined
  /** 文件内容读取方式。 */
  mode: 'worktree' | 'merged'
}

/** 集成模式：diff 集成提交与其父提交（首个提交回退到空树）。 */
async function resolveMergedScope (board: Board, item: WorkItem): Promise<PreviewScope> {
  const parent = (await git(board.projectPath, ['rev-parse', '--verify', `${item.commitRef}^`]).catch(() => '')).trim()
  return {
    cwd: board.projectPath,
    base: parent === '' ? EMPTY_TREE : parent,
    head: item.commitRef,
    mode: 'merged'
  }
}

/** 解析预览来源；worktree 失效但已集成时回退集成模式，两者皆无则 409。 */
async function resolvePreviewScope (board: Board, item: WorkItem): Promise<PreviewScope> {
  const workspace = item.taskWorkspace
  if (workspace !== undefined) {
    const exists = await stat(workspace.path).then(() => true).catch(() => false)
    if (exists) return { cwd: workspace.path, base: workspace.baseCommit, mode: 'worktree' }
    if (item.commitRef !== undefined) return resolveMergedScope(board, item)
    throw new HttpError(409, '任务工作目录已被清理，无法预览任务中的改动')
  }
  if (item.commitRef !== undefined) return resolveMergedScope(board, item)
  throw new HttpError(409, '该工作项当前没有可预览的改动（没有任务工作目录，也没有已集成的提交）')
}

/** 单个改动文件。 */
interface DiffFile {
  path: string
  adds: number | null // null = 二进制
  deletes: number | null
  binary: boolean
  diff: string
}

/** 收集改动文件（--no-renames：重命名表现为删除+新增，避免 "old => new" 解析）。 */
async function collectChangedFiles (scope: PreviewScope): Promise<DiffFile[]> {
  const args = ['diff', '--no-renames', '--numstat', scope.base]
  if (scope.head !== undefined) args.push(scope.head)
  const output = await git(scope.cwd, args)
  const files: DiffFile[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const [addsRaw, deletesRaw, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t')
    if (path === '') continue
    const binary = addsRaw === '-' || deletesRaw === '-'
    let diff = ''
    if (!binary) {
      const fileArgs = ['diff', '--no-renames', scope.base]
      if (scope.head !== undefined) fileArgs.push(scope.head)
      fileArgs.push('--', path)
      diff = await git(scope.cwd, fileArgs)
    }
    files.push({
      path,
      adds: binary ? null : Number(addsRaw),
      deletes: binary ? null : Number(deletesRaw),
      binary,
      diff
    })
  }
  return files
}

/** HTML 转义（所有动态内容进入页面前必须转义）。 */
function escapeHtml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 28px 48px;
    background: #16181d; color: #d5d8e0;
    font: 14px/1.6 -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  header { max-width: 1080px; margin: 0 auto 18px; }
  h1 { margin: 0 0 6px; font-size: 18px; color: #eef0f5; word-break: break-word; }
  .meta { margin: 0; color: #8b90a0; font-size: 12px; }
  .meta code { color: #b8c2d8; }
  main { max-width: 1080px; margin: 0 auto; }
  .summary {
    margin: 0 0 14px; padding: 10px 14px;
    background: #1e222a; border: 1px solid #2c313c; border-radius: 10px;
    color: #b8c2d8; font-size: 13px;
  }
  .summary b { color: #eef0f5; }
  details {
    margin-bottom: 10px;
    background: #1e222a; border: 1px solid #2c313c; border-radius: 10px;
    overflow: hidden;
  }
  summary {
    padding: 9px 14px; cursor: pointer; user-select: none;
    font-size: 13px; color: #eef0f5; word-break: break-all;
  }
  summary:hover { background: #232833; }
  summary .stat { color: #8b90a0; font-size: 12px; margin-left: 8px; }
  summary .add { color: #3fb950; }
  summary .del { color: #f85149; }
  .fileBody { padding: 0 14px 12px; }
  .fileBody .links { margin: 8px 0 0; font-size: 12px; }
  .fileBody .links a { color: #6fa8ff; text-decoration: none; }
  .fileBody .links a:hover { text-decoration: underline; }
  pre.diff {
    margin: 0; padding: 10px 12px; overflow-x: auto;
    background: #14161b; border: 1px solid #2c313c; border-radius: 8px;
    font: 12px/1.55 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  pre.diff .d-add { color: #7ee787; background: rgba(63, 185, 80, .12); }
  pre.diff .d-del { color: #ffa198; background: rgba(248, 81, 73, .12); }
  pre.diff .d-meta { color: #6fa8ff; }
  pre.diff .d-hunk { color: #8b90a0; }
  pre.file {
    margin: 0; padding: 14px 16px; overflow-x: auto;
    background: #14161b; border: 1px solid #2c313c; border-radius: 10px;
    font: 12px/1.6 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    white-space: pre;
  }
  .back { color: #6fa8ff; text-decoration: none; font-size: 12px; }
  .back:hover { text-decoration: underline; }
  .empty { color: #8b90a0; padding: 30px; text-align: center; }
`

/** diff 行着色：以行首字符判断 + / - / @@ / 其余。 */
function colorizeDiff (diff: string): string {
  return diff.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
      return `<span class="d-meta">${escapeHtml(line)}</span>`
    }
    if (line.startsWith('@@')) return `<span class="d-hunk">${escapeHtml(line)}</span>`
    if (line.startsWith('+')) return `<span class="d-add">${escapeHtml(line)}</span>`
    if (line.startsWith('-')) return `<span class="d-del">${escapeHtml(line)}</span>`
    return escapeHtml(line)
  }).join('\n')
}

/** 校验文件路径参数：拒绝绝对路径与 .. 逃逸。 */
function safeRelPath (root: string, requested: string): string {
  if (requested === '' || requested.includes('\0')) throw new HttpError(400, 'path 参数无效')
  const resolved = resolve(root, requested)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new HttpError(400, 'path 超出可预览范围')
  }
  return requested
}

/** 渲染单文件内容页。 */
export async function renderFilePreview (board: Board, item: WorkItem, requestedPath: string): Promise<string> {
  const scope = await resolvePreviewScope(board, item)
  const relPath = safeRelPath(scope.mode === 'worktree' ? scope.cwd : board.projectPath, requestedPath)
  const raw = scope.mode === 'worktree'
    ? await readFile(resolve(scope.cwd, relPath)).catch(() => { throw new HttpError(404, '文件不存在或无法读取') })
    : (await execGit(scope.cwd, ['show', `${scope.head}:${relPath}`]).catch(() => { throw new HttpError(404, '提交中不存在该文件') })).stdout
  const { content, binary } = decodeText(raw)
  const body = binary
    ? '<p class="empty">二进制文件，无法预览内容。</p>'
    : `<pre class="file">${escapeHtml(content)}</pre>`
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(item.title)} · 文件预览</title><style>${PAGE_STYLE}</style></head>
<body><header>
  <a class="back" href="/taskboard/boards/${encodeURIComponent(board.projectKey)}/items/${encodeURIComponent(item.id)}/preview">← 返回改动预览</a>
  <h1>${escapeHtml(relPath)}</h1>
  <p class="meta">${escapeHtml(item.title)}${scope.head === undefined ? '（任务工作目录当前内容）' : `（集成提交 <code>${escapeHtml(scope.head)}</code> 中的内容）`}</p>
</header><main>${body}</main></body></html>`
}

/** 渲染工作项改动预览页。 */
export async function renderItemPreview (board: Board, item: WorkItem): Promise<string> {
  const scope = await resolvePreviewScope(board, item)
  const files = await collectChangedFiles(scope)
  const totalAdds = files.reduce((sum, file) => sum + (file.adds ?? 0), 0)
  const totalDeletes = files.reduce((sum, file) => sum + (file.deletes ?? 0), 0)
  const columnLabel = board.columns.find(column => column.id === item.status)?.label ?? item.status

  const fileSections = files.length === 0
    ? '<p class="empty">当前没有可显示的改动。</p>'
    : files.map(file => {
      const statHtml = file.binary
        ? '<span class="stat">二进制文件</span>'
        : `<span class="stat">+<span class="add">${file.adds}</span> / -<span class="del">${file.deletes}</span></span>`
      const diffHtml = file.binary
        ? ''
        : `<pre class="diff">${colorizeDiff(file.diff)}</pre>`
      const fileUrl = `/taskboard/boards/${encodeURIComponent(board.projectKey)}/items/${encodeURIComponent(item.id)}/preview/file?path=${encodeURIComponent(file.path)}`
      return `<details${file.binary || files.length === 1 ? ' open' : ''}><summary>${escapeHtml(file.path)}${statHtml}</summary>
  <div class="fileBody">${diffHtml}<p class="links"><a href="${escapeHtml(fileUrl)}" target="_blank" rel="noreferrer">查看完整文件</a></p></div>
</details>`
    }).join('\n')

  const scopeHtml = scope.head === undefined
    ? `任务分支 <code>${escapeHtml(item.taskWorkspace?.branch ?? '')}</code> 基线 <code>${escapeHtml(scope.base)}</code> 以来的改动（含 Agent 未提交内容）`
    : `集成提交 <code>${escapeHtml(scope.head)}</code>（相对其父提交）`

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(item.title)} · 改动预览</title><style>${PAGE_STYLE}</style></head>
<body><header>
  <h1>${escapeHtml(item.title)}</h1>
  <p class="meta">环节：${escapeHtml(columnLabel)} · 修改文件 ${files.length} 个 · <span class="add">+${totalAdds}</span> / <span class="del">-${totalDeletes}</span></p>
</header><main>
  <p class="summary">预览来源：${scopeHtml}</p>
  ${fileSections}
</main></body></html>`
}
