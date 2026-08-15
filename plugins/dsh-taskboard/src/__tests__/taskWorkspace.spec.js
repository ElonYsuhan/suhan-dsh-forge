import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { commitTaskWorkspace, discardTaskWorkspace, integrateTaskWorkspace, prepareTaskWorkspace } from '../taskWorkspace.ts'

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

  it('refuses to create an isolated task while the main worktree is dirty', async () => {
    const root = await repository()
    const storage = await mkdtemp(join(tmpdir(), 'dsh-taskboard-dirty-'))
    tempDirs.push(storage)
    await writeFile(join(root, 'shared.txt'), 'dirty\n')
    await expect(prepareTaskWorkspace(root, 'task-dirty', storage)).rejects.toThrow('未提交改动')
  })
})
