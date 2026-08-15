import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { captureGitCheckpoint, restoreGitCheckpoint } from '../gitCheckpoint.ts'

const execFileAsync = promisify(execFile)
const tempDirs = []

async function git (cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('git checkpoint', () => {
  it('restores tracked, staged and pre-existing untracked content while removing task files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-git-'))
    tempDirs.push(root)
    await git(root, 'init')
    await git(root, 'config', 'user.name', 'Taskboard Test')
    await git(root, 'config', 'user.email', 'taskboard@example.test')
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'initial')
    await writeFile(join(root, 'staged.txt'), 'staged before\n')
    await git(root, 'add', 'staged.txt')
    await writeFile(join(root, 'untracked.txt'), 'untracked before\n')
    const statusBefore = await git(root, 'status', '--porcelain=v1')

    const checkpoint = await captureGitCheckpoint(root)
    await writeFile(join(root, 'tracked.txt'), 'task changed\n')
    await writeFile(join(root, 'staged.txt'), 'task changed staged file\n')
    await writeFile(join(root, 'untracked.txt'), 'task changed untracked file\n')
    await writeFile(join(root, 'task-created.txt'), 'remove me\n')

    await restoreGitCheckpoint(checkpoint)

    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('before\n')
    expect(await readFile(join(root, 'staged.txt'), 'utf8')).toBe('staged before\n')
    expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe('untracked before\n')
    await expect(readFile(join(root, 'task-created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'status', '--porcelain=v1')).toBe(statusBefore)
  })

  it('refuses to restore across a changed HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-git-head-'))
    tempDirs.push(root)
    await git(root, 'init')
    await git(root, 'config', 'user.name', 'Taskboard Test')
    await git(root, 'config', 'user.email', 'taskboard@example.test')
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'initial')
    const checkpoint = await captureGitCheckpoint(root)
    await writeFile(join(root, 'tracked.txt'), 'committed later\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'later')

    await expect(restoreGitCheckpoint(checkpoint)).rejects.toThrow('HEAD 已变化')
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('committed later\n')
  })
})
