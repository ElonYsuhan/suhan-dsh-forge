import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { commitTaskWorkspace, discardTaskWorkspace, integrateTaskWorkspace, prepareTaskWorkspace, resolveGitRoot, TaskWorkspacePreconditionError } from '../taskWorkspace.ts'

const execFileAsync = promisify(execFile)
const tempDirs = []

async function git (cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

async function repository () {
  const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-worktrees-'))
  tempDirs.push(root)
  await git(root, 'init')
  await git(root, 'config', 'user.name', 'Taskboard Test')
  await git(root, 'config', 'user.email', 'taskboard@example.test')
  await writeFile(join(root, 'shared.txt'), 'base\n')
  await git(root, 'add', 'shared.txt')
  await git(root, 'commit', '-m', 'initial')
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('task worktree integration', () => {
  it('reports a safe precondition error for a non-Git workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-non-git-'))
    tempDirs.push(root)

    await expect(resolveGitRoot(root)).rejects.toEqual(expect.objectContaining({
      name: 'TaskWorkspacePreconditionError',
      message: expect.stringContaining('不是 Git 仓库')
    }))
    await expect(resolveGitRoot(root)).rejects.toBeInstanceOf(TaskWorkspacePreconditionError)
  })

  it('runs independent tasks in parallel and linearly integrates both commits', async () => {
    const root = await repository()
    const storage = await mkdtemp(join(tmpdir(), 'dsh-taskboard-storage-'))
    tempDirs.push(storage)
    const first = await prepareTaskWorkspace(root, 'task-a', storage)
    const second = await prepareTaskWorkspace(root, 'task-b', storage)

    await writeFile(join(first.path, 'a.txt'), 'task a\n')
    await writeFile(join(second.path, 'b.txt'), 'task b\n')
    await commitTaskWorkspace(first, 'task-a', 'first task')
    await commitTaskWorkspace(second, 'task-b', 'second task')

    const firstResult = await integrateTaskWorkspace(first)
    const secondResult = await integrateTaskWorkspace(second)
    expect(firstResult.kind).toBe('merged')
    expect(secondResult.kind).toBe('merged')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('task a\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('task b\n')
    expect((await git(root, 'log', '--format=%s')).split('\n').slice(0, 2)).toEqual([
      'taskboard(task-b): second task',
      'taskboard(task-a): first task'
    ])

    await discardTaskWorkspace(first)
    await discardTaskWorkspace(second)
  })

  it('preserves the source commit when concurrent tasks edit the same lines', async () => {
    const root = await repository()
    const storage = await mkdtemp(join(tmpdir(), 'dsh-taskboard-conflict-'))
    tempDirs.push(storage)
    const first = await prepareTaskWorkspace(root, 'task-c', storage)
    const second = await prepareTaskWorkspace(root, 'task-d', storage)

    await writeFile(join(first.path, 'shared.txt'), 'first\n')
    await writeFile(join(second.path, 'shared.txt'), 'second\n')
    await commitTaskWorkspace(first, 'task-c', 'first conflict side')
    const sourceCommit = await commitTaskWorkspace(second, 'task-d', 'second conflict side')
    expect((await integrateTaskWorkspace(first)).kind).toBe('merged')

    const result = await integrateTaskWorkspace(second)
    expect(result.kind).toBe('conflicted')
    if (result.kind === 'conflicted') expect(result.sourceCommit).toBe(sourceCommit)
    expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe('first\n')
    expect(await git(second.path, 'rev-parse', 'HEAD')).toBe(sourceCommit)

    await discardTaskWorkspace(first)
    await discardTaskWorkspace(second)
  })

  it('snapshots a dirty main worktree without changing it and later integrates only task changes', async () => {
    const root = await repository()
    const storage = await mkdtemp(join(tmpdir(), 'dsh-taskboard-dirty-'))
    tempDirs.push(storage)
    await writeFile(join(root, 'shared.txt'), 'dirty\n')
    const workspace = await prepareTaskWorkspace(root, 'task-dirty', storage)

    expect(await readFile(join(workspace.path, 'shared.txt'), 'utf8')).toBe('dirty\n')
    expect(await git(root, 'status', '--porcelain')).toContain('shared.txt')
    await writeFile(join(workspace.path, 'task.txt'), 'task only\n')
    await commitTaskWorkspace(workspace, 'task-dirty', 'dirty baseline task')
    expect((await integrateTaskWorkspace(workspace)).kind).toBe('conflicted')

    await git(root, 'add', 'shared.txt')
    await git(root, 'commit', '-m', 'user saves existing work')
    expect((await integrateTaskWorkspace(workspace)).kind).toBe('merged')
    expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe('dirty\n')
    expect(await readFile(join(root, 'task.txt'), 'utf8')).toBe('task only\n')
    expect(await git(root, 'show', '--format=', '--name-only', 'HEAD')).toBe('task.txt')
    await discardTaskWorkspace(workspace)
  })

  it('recovers the deterministic worktree after a host restart during bootstrap', async () => {
    const root = await repository()
    const storage = await mkdtemp(join(tmpdir(), 'dsh-taskboard-recovery-'))
    tempDirs.push(storage)
    const original = await prepareTaskWorkspace(root, 'task-recovery', storage)
    await writeFile(join(original.path, 'partial.txt'), 'preserved partial work\n')

    const recovered = await prepareTaskWorkspace(root, 'task-recovery', storage)
    expect(recovered).toEqual(original)
    expect(await readFile(join(recovered.path, 'partial.txt'), 'utf8')).toBe('preserved partial work\n')
    await discardTaskWorkspace(recovered)
  })
})
