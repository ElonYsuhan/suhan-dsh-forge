import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HttpError } from '../http.ts'
import { renderFilePreview, renderItemPreview } from '../preview.ts'

const execFileAsync = promisify(execFile)

async function git (cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout
}

function board () {
  return {
    projectKey: 'workspace-1',
    projectPath: repoRoot,
    projectTitle: '测试项目',
    columns: [
      { id: 'todo', label: '创意想法' },
      { id: 'in-dev', label: '开发落地' },
      { id: 'accept', label: '验收提交合并' }
    ],
    itemTypes: [],
    items: [],
    updatedAt: '2026-08-20T00:00:00.000Z'
  }
}

function item (overrides) {
  return {
    id: 'item-1',
    type: 'task',
    title: '测试任务',
    desc: '',
    priority: 'medium',
    labels: [],
    status: 'in-dev',
    executionState: 'running',
    timeline: [],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    archived: false,
    ...overrides
  }
}

let repoRoot
let singleCommitRoot
let baseCommit
let taskCommit
let singleCommit

beforeAll(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'dsh-taskboard-preview-'))
  await git(repoRoot, ['init', '-b', 'main'])
  await git(repoRoot, ['config', 'user.email', 'test@localhost'])
  await git(repoRoot, ['config', 'user.name', 'Test'])
  await writeFile(join(repoRoot, 'a.txt'), 'one\n')
  await writeFile(join(repoRoot, 'd.bin'), Buffer.from([0x00, 0x01, 0x02]))
  await git(repoRoot, ['add', '.'])
  await git(repoRoot, ['commit', '-m', 'init'])
  baseCommit = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim()
  // 任务改动：未提交（worktree 模式预览对象）
  await writeFile(join(repoRoot, 'a.txt'), 'two\n')
  await writeFile(join(repoRoot, 'c.txt'), 'new file\n')
  await writeFile(join(repoRoot, 'd.bin'), Buffer.from([0x00, 0xff, 0xfe]))
  // 集成提交（merged 模式预览对象）
  await git(repoRoot, ['add', '.'])
  await git(repoRoot, ['commit', '-m', 'task: work'])
  taskCommit = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim()

  // 单提交仓库：集成提交无父 → 空树 diff
  singleCommitRoot = await mkdtemp(join(tmpdir(), 'dsh-taskboard-preview-single-'))
  await git(singleCommitRoot, ['init', '-b', 'main'])
  await git(singleCommitRoot, ['config', 'user.email', 'test@localhost'])
  await git(singleCommitRoot, ['config', 'user.name', 'Test'])
  await writeFile(join(singleCommitRoot, 'only.txt'), 'only\n')
  await git(singleCommitRoot, ['add', '.'])
  await git(singleCommitRoot, ['commit', '-m', 'first'])
  singleCommit = (await git(singleCommitRoot, ['rev-parse', 'HEAD'])).trim()
})

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true })
  await rm(singleCommitRoot, { recursive: true, force: true })
})

describe('工作项改动预览（preview.ts）', () => {
  it('worktree 模式：diff 任务基线到工作树（含未提交改动），列出文件与着色 diff', async () => {
    const html = await renderItemPreview(board(), item({
      taskWorkspace: { root: repoRoot, path: repoRoot, branch: 'dsh-taskboard/item-1', baseCommit, targetBranch: 'main' }
    }))
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('a.txt')
    expect(html).toContain('c.txt')
    expect(html).toContain('d.bin')
    expect(html).toContain('二进制文件')
    expect(html).toContain('two')
    expect(html).toContain('new file')
    expect(html).toContain('查看完整文件')
    expect(html).toContain('d-add')
    expect(html).toContain('d-del')
    // 只展示改动文件：基线里的 b/… 未出现
    expect(html).not.toContain('baseCommit')
  })

  it('merged 模式：diff 集成提交与其父提交', async () => {
    const html = await renderItemPreview(board(), item({
      status: 'accept',
      taskWorkspace: undefined,
      commitRef: taskCommit,
      creationState: 'completed',
      executionState: 'idle'
    }))
    expect(html).toContain('a.txt')
    expect(html).toContain('c.txt')
    expect(html).toContain('集成提交')
    expect(html).toContain('d-add')
  })

  it('merged 模式首个提交：空树 diff 兜底', async () => {
    const html = await renderItemPreview({
      ...board(),
      projectPath: singleCommitRoot
    }, item({ commitRef: singleCommit }))
    expect(html).toContain('only.txt')
  })

  it('没有任务 worktree 也没有集成提交 → 409', async () => {
    await expect(renderItemPreview(board(), item({}))).rejects.toThrow(HttpError)
    await expect(renderItemPreview(board(), item({}))).rejects.toMatchObject({ status: 409 })
  })

  it('任务 worktree 目录已被清理 → 409', async () => {
    await expect(renderItemPreview(board(), item({
      taskWorkspace: { root: repoRoot, path: join(repoRoot, 'gone'), branch: 'b', baseCommit, targetBranch: 'main' }
    }))).rejects.toMatchObject({ status: 409 })
  })

  it('worktree 已清理但已集成 → 回退集成模式', async () => {
    const html = await renderItemPreview(board(), item({
      taskWorkspace: { root: repoRoot, path: join(repoRoot, 'gone'), branch: 'b', baseCommit, targetBranch: 'main' },
      commitRef: taskCommit
    }))
    expect(html).toContain('集成提交')
    expect(html).toContain('c.txt')
  })

  it('文件内容页：worktree 模式读磁盘当前内容', async () => {
    const html = await renderFilePreview(board(), item({
      taskWorkspace: { root: repoRoot, path: repoRoot, branch: 'b', baseCommit, targetBranch: 'main' }
    }), 'c.txt')
    expect(html).toContain('new file')
    expect(html).toContain('返回改动预览')
  })

  it('文件内容页：merged 模式取集成提交中的精确内容', async () => {
    const html = await renderFilePreview(board(), item({ commitRef: taskCommit }), 'c.txt')
    expect(html).toContain('new file')
    const before = await renderFilePreview(board(), item({ commitRef: taskCommit }), 'a.txt')
    expect(before).toContain('two')
  })

  it('文件内容页：二进制文件提示', async () => {
    const html = await renderFilePreview(board(), item({
      taskWorkspace: { root: repoRoot, path: repoRoot, branch: 'b', baseCommit, targetBranch: 'main' }
    }), 'd.bin')
    expect(html).toContain('二进制文件')
  })

  it('文件内容页：路径穿越被拒绝', async () => {
    await expect(renderFilePreview(board(), item({
      taskWorkspace: { root: repoRoot, path: repoRoot, branch: 'b', baseCommit, targetBranch: 'main' }
    }), '../outside.txt')).rejects.toMatchObject({ status: 400 })
    await expect(renderFilePreview(board(), item({ commitRef: taskCommit }), '/etc/passwd')).rejects.toMatchObject({ status: 400 })
  })

  it('文件内容页：不存在的文件 → 404', async () => {
    await expect(renderFilePreview(board(), item({
      taskWorkspace: { root: repoRoot, path: repoRoot, branch: 'b', baseCommit, targetBranch: 'main' }
    }), 'missing.txt')).rejects.toMatchObject({ status: 404 })
  })

  it('HTML 转义：文件与标题中的尖括号不注入标签', async () => {
    await writeFile(join(repoRoot, 'x<y>.txt'), 'escaped\n')
    const html = await renderItemPreview(board(), item({
      title: '含 <script> 的标题',
      taskWorkspace: { root: repoRoot, path: repoRoot, branch: 'b', baseCommit, targetBranch: 'main' }
    }))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
