import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readStoredBoards, TaskboardDataError, taskboardDataPaths } from '../storage.ts'
import { createBoard } from '../shared/types.ts'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('taskboard persistent storage', () => {
  it('uses DSH_HOME storage instead of the install directory', () => {
    const paths = taskboardDataPaths('file:///tmp/plugin/lib/index.js', { DSH_HOME: '/tmp/custom-dsh-home' })
    expect(paths.dataFile).toBe('/tmp/custom-dsh-home/storages/dsh-taskboard/boards.json')
    expect(paths.legacyDataFile).toBe('/tmp/plugin/datas/boards.json')
  })

  it('falls back to legacy data only when the stable file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-storage-'))
    tempDirs.push(root)
    const primary = join(root, 'stable', 'boards.json')
    const legacy = join(root, 'legacy.json')
    await writeFile(legacy, JSON.stringify({ version: 2, boards: { legacy: createBoard('legacy', root, '旧项目') } }))

    const migrated = await readStoredBoards({ dataFile: primary, legacyDataFile: legacy })
    expect(migrated?.source).toBe('legacy')
    expect(migrated?.file.boards.legacy).toBeDefined()

    await mkdir(join(root, 'stable'), { recursive: true })
    await writeFile(primary, JSON.stringify({ version: 2, boards: { stable: createBoard('stable', root, '当前项目') } }))
    const current = await readStoredBoards({ dataFile: primary, legacyDataFile: legacy })
    expect(current?.source).toBe('primary')
    expect(current?.file.boards.stable).toBeDefined()
  })

  it('recovers a corrupt primary file from the last valid backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-storage-'))
    tempDirs.push(root)
    const primary = join(root, 'boards.json')
    const backup = `${primary}.bak`
    await writeFile(primary, '{broken')
    await writeFile(backup, JSON.stringify({ version: 2, boards: { recovered: createBoard('recovered', root, '恢复项目') } }))
    const stored = await readStoredBoards({ dataFile: primary })
    expect(stored?.source).toBe('backup')
    expect(stored?.file.boards.recovered).toBeDefined()

    await writeFile(backup, '{also-broken')
    await expect(readStoredBoards({ dataFile: primary })).rejects.toBeInstanceOf(TaskboardDataError)
  })

  it('round-trips AI 创建流程字段并拒绝畸形方案结构', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-taskboard-storage-'))
    tempDirs.push(root)
    const primary = join(root, 'boards.json')
    const board = createBoard('ai', root, 'AI 项目')
    board.items.push({
      id: 'ai-item',
      type: 'task',
      title: '登录功能',
      desc: '给系统加个登录功能',
      originalRequirement: '给系统加个登录功能',
      creationState: 'pending_confirm',
      aiAnalysis: {
        suggestedTitle: '登录功能',
        requirementUnderstanding: '账号密码登录',
        projectAnalysis: '无既有模块',
        implementationPlan: ['新增 auth.ts'],
        affectedModules: ['router.ts'],
        pendingQuestions: ['登录态有效期？'],
        acceptanceCriteria: ['能登录']
      },
      frozenPlan: '# 登录功能\n\n## 需求理解\n账号密码登录',
      priority: 'medium',
      labels: [],
      status: 'todo',
      timeline: [],
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      archived: false
    })
    await writeFile(primary, JSON.stringify({ version: 2, boards: { ai: board } }))
    const stored = await readStoredBoards({ dataFile: primary })
    const item = stored?.file.boards.ai.items[0]
    expect(item?.creationState).toBe('pending_confirm')
    expect(item?.aiAnalysis?.implementationPlan).toEqual(['新增 auth.ts'])
    expect(item?.frozenPlan).toContain('## 需求理解')

    // 畸形 aiAnalysis（implementationPlan 含对象）→ 拒绝加载
    board.items[0].aiAnalysis = { ...board.items[0].aiAnalysis, implementationPlan: [{ not: 'a string' }] }
    await writeFile(primary, JSON.stringify({ version: 2, boards: { ai: board } }))
    await expect(readStoredBoards({ dataFile: primary })).rejects.toBeInstanceOf(TaskboardDataError)
  })
})
