/**
 * 工作项 Git 基线：不改动真实 index/worktree，只借助临时 index 写入快照 tree。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { GitCheckpoint } from './shared/types.ts'

const execFileAsync = promisify(execFile)

/** 执行 Git 并返回 stdout；参数始终以数组传递，避免 shell 插值。 */
async function git (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  return stdout
}

/** 尝试读取当前 HEAD；尚无提交的仓库返回 undefined。 */
async function currentHead (root: string): Promise<string | undefined> {
  try {
    return (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
  } catch {
    return undefined
  }
}

/** NUL 分隔的 Git 路径输出。 */
function gitPaths (output: string): string[] {
  return output.split('\0').filter(path => path !== '')
}

/** 确保待删除路径严格位于仓库根目录内。 */
function safeWorkspacePath (root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Git 返回了绝对路径，拒绝回退：${path}`)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`路径越出工作区，拒绝回退：${path}`)
  }
  return target
}

/**
 * 捕获任务开始前的工作树内容与真实暂存区状态。
 * @param cwd - 任务工作目录（必须位于 Git 工作树）。
 * @returns 可持久化的 Git tree 基线。
 * @example
 * const checkpoint = await captureGitCheckpoint('/workspace/project')
 */
export async function captureGitCheckpoint (cwd: string): Promise<GitCheckpoint> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  if (root === '') throw new Error('无法确定 Git 工作树根目录')
  const indexTree = (await git(root, ['write-tree'])).trim()
  const head = await currentHead(root)
  const tempDir = await mkdtemp(join(tmpdir(), 'nexa-taskboard-checkpoint-'))
  const tempIndex = join(tempDir, 'index')
  const snapshotEnv = { ...process.env, GIT_INDEX_FILE: tempIndex }
  try {
    await git(root, ['read-tree', '--empty'], snapshotEnv)
    await git(root, ['add', '-A', '--', '.'], snapshotEnv)
    const worktreeTree = (await git(root, ['write-tree'], snapshotEnv)).trim()
    return {
      kind: 'git-tree',
      root,
      head,
      indexTree,
      worktreeTree,
      capturedAt: new Date().toISOString()
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * 恢复任务基线；若 HEAD 已变化则拒绝执行，避免覆盖任务外提交。
 * @param checkpoint - 首次执行前捕获的基线。
 * @example
 * await restoreGitCheckpoint(checkpoint)
 */
export async function restoreGitCheckpoint (checkpoint: GitCheckpoint): Promise<void> {
  const root = (await git(checkpoint.root, ['rev-parse', '--show-toplevel'])).trim()
  if (resolve(root) !== resolve(checkpoint.root)) throw new Error('Git 工作树根目录已变化，无法安全回退')
  const head = await currentHead(root)
  if (head !== checkpoint.head) {
    throw new Error('任务执行期间 HEAD 已变化；为避免撤销其他提交，已停止自动回退')
  }

  const currentPaths = gitPaths(await git(root, ['ls-files', '-co', '--exclude-standard', '-z']))
  const baselinePaths = new Set(gitPaths(await git(root, ['ls-tree', '-r', '--name-only', '-z', checkpoint.worktreeTree])))
  const tempDir = await mkdtemp(join(tmpdir(), 'nexa-taskboard-restore-'))
  const tempIndex = join(tempDir, 'index')
  const snapshotEnv = { ...process.env, GIT_INDEX_FILE: tempIndex }
  try {
    await git(root, ['read-tree', checkpoint.worktreeTree], snapshotEnv)
    await git(root, ['checkout-index', '--all', '--force'], snapshotEnv)
    for (const path of currentPaths) {
      if (!baselinePaths.has(path)) await rm(safeWorkspacePath(root, path), { recursive: true, force: true })
    }
    await git(root, ['read-tree', checkpoint.indexTree])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
