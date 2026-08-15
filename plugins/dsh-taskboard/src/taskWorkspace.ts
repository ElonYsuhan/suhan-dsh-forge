/**
 * 每任务 Git 隔离与串行集成。
 * Agent 只操作独立 worktree；主工作区只在最终 ff-only 集成的短临界区变化。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import type { TaskWorkspace } from './shared/types.ts'

const execFileAsync = promisify(execFile)

/** 无法安全创建独立任务 worktree 的可恢复前置条件错误。 */
export class TaskWorkspacePreconditionError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'TaskWorkspacePreconditionError'
  }
}

async function git (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: env === undefined ? process.env : { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000
  })
  return stdout
}

/**
 * 用临时 Git index 捕获当前非忽略工作树，不触碰用户 index/工作区。
 * 返回的合成提交只作为任务分支基线；最终只重放它之后的任务提交。
 */
async function snapshotBaseCommit (root: string, head: string, repositoryStorage: string): Promise<string> {
  if (await status(root) === '') return head
  const temp = await mkdtemp(resolve(repositoryStorage, '.snapshot-'))
  const index = resolve(temp, 'index')
  const env = { GIT_INDEX_FILE: index }
  try {
    await git(root, ['read-tree', head], env)
    await git(root, ['add', '-A', '--', '.'], env)
    const tree = (await git(root, ['write-tree'], env)).trim()
    return (await git(root, [
      '-c', 'user.name=DSH Taskboard',
      '-c', 'user.email=dsh-taskboard@localhost',
      'commit-tree', tree, '-p', head, '-m', 'taskboard: capture uncommitted task baseline'
    ], env)).trim()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function status (cwd: string): Promise<string> {
  return (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()
}

function branchName (itemId: string): string {
  return `dsh-taskboard/${itemId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)}`
}

/** 返回规范化 Git 根目录，供调度器使用同一把仓库锁。 */
export async function resolveGitRoot (projectPath: string): Promise<string> {
  try {
    return resolve((await git(projectPath, ['rev-parse', '--show-toplevel'])).trim())
  } catch {
    throw new TaskWorkspacePreconditionError('当前工作区不是 Git 仓库。任务执行需要独立 Git worktree；请先初始化 Git、创建首次提交后重试。')
  }
}

/** 为任务创建独立分支和 worktree；未提交现场以只读合成提交成为任务基线。 */
export async function prepareTaskWorkspace (
  projectPath: string,
  itemId: string,
  storageRoot: string
): Promise<TaskWorkspace> {
  const root = await resolveGitRoot(projectPath)
  const targetBranch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
  if (targetBranch === '') throw new TaskWorkspacePreconditionError('项目当前处于 detached HEAD，无法确定自动集成目标分支；请先切换到目标分支。')
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const repositoryKey = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const path = resolve(storageRoot, repositoryKey, itemId)
  const branch = branchName(itemId)
  const repositoryStorage = resolve(storageRoot, repositoryKey)
  await mkdir(repositoryStorage, { recursive: true })
  const baseCommit = await snapshotBaseCommit(root, head, repositoryStorage)
  try {
    await git(path, ['rev-parse', '--show-toplevel'])
    const existingBranch = (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    if (existingBranch === branch) {
      return { root, path, branch, baseCommit: (await git(path, ['rev-parse', 'HEAD'])).trim(), targetBranch }
    }
  } catch {
    // 不存在完整 worktree 时，继续检查是否只留下了任务分支。
  }
  const branchExists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    .then(() => true, () => false)
  await git(root, branchExists
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, baseCommit])
  const taskBaseCommit = branchExists ? (await git(path, ['rev-parse', 'HEAD'])).trim() : baseCommit
  return { root, path, branch, baseCommit: taskBaseCommit, targetBranch }
}

/** 把任务 worktree 的全部变化压成一条任务提交；无文件变化也生成审计提交。 */
export async function commitTaskWorkspace (workspace: TaskWorkspace, itemId: string, title: string): Promise<string> {
  const head = (await git(workspace.path, ['rev-parse', 'HEAD'])).trim()
  if (head !== workspace.baseCommit) {
    throw new Error('任务分支在交付前出现了未经插件管理的提交；为避免夹带提交，已停止自动集成')
  }
  await git(workspace.path, ['add', '-A', '--', '.'])
  const subject = title.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || '完成工作项'
  await git(workspace.path, [
    '-c', 'user.name=DSH Taskboard',
    '-c', 'user.email=dsh-taskboard@localhost',
    'commit', '--allow-empty', '-m', `taskboard(${itemId.slice(0, 8)}): ${subject}`
  ])
  return (await git(workspace.path, ['rev-parse', 'HEAD'])).trim()
}

export type IntegrationResult =
  | { kind: 'merged'; commit: string }
  | { kind: 'conflicted'; sourceCommit: string; reason: string }

/**
 * 将任务提交重放到最新目标分支，再以 ff-only 更新主工作区。
 * 调用方必须持有以 workspace.root 为键的集成锁。
 */
export async function integrateTaskWorkspace (workspace: TaskWorkspace): Promise<IntegrationResult> {
  const sourceCommit = (await git(workspace.path, ['rev-parse', 'HEAD'])).trim()
  const currentBranch = (await git(workspace.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
  if (currentBranch !== workspace.targetBranch) {
    return { kind: 'conflicted', sourceCommit, reason: `目标工作区已从 ${workspace.targetBranch} 切换到 ${currentBranch || 'detached HEAD'}` }
  }
  if (await status(workspace.root) !== '') {
    return { kind: 'conflicted', sourceCommit, reason: '目标工作区存在人工或其他进程产生的未提交改动' }
  }

  try {
    await git(workspace.path, ['rebase', '--keep-empty', '--onto', workspace.targetBranch, workspace.baseCommit, workspace.branch])
  } catch (error) {
    await git(workspace.path, ['rebase', '--abort']).catch(() => {})
    return {
      kind: 'conflicted',
      sourceCommit,
      reason: `任务提交无法自动重放到最新 ${workspace.targetBranch}：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const rebasedCommit = (await git(workspace.path, ['rev-parse', 'HEAD'])).trim()
  try {
    await git(workspace.root, ['merge', '--ff-only', workspace.branch])
  } catch (error) {
    return {
      kind: 'conflicted',
      sourceCommit: rebasedCommit,
      reason: `目标分支在集成期间发生变化：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { kind: 'merged', commit: rebasedCommit }
}

/** 删除任务 worktree；冲突现场需要保留分支时只移除 worktree。 */
export async function discardTaskWorkspace (workspace: TaskWorkspace, keepBranch = false): Promise<void> {
  await git(workspace.root, ['worktree', 'remove', '--force', workspace.path]).catch(() => {})
  await git(workspace.root, ['worktree', 'prune']).catch(() => {})
  if (!keepBranch) await git(workspace.root, ['branch', '-D', workspace.branch]).catch(() => {})
}

/** 冲突处理任务成功后清理原任务保留的源分支。 */
export async function deleteTaskBranch (root: string, branch: string): Promise<void> {
  await git(root, ['branch', '-D', branch]).catch(() => {})
}
