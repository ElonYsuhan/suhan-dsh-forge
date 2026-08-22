import { describe, expect, it } from 'vitest'
import { createBoard } from '../shared/types.ts'
import { createItemFromBody, normalizePreviewUrls, validateAiAnalysisBody, validateItemPatch, validateSettings } from '../validation.ts'

function itemBody (title = '任务') {
  return { title, type: 'task', desc: '', priority: 'medium', labels: [], status: 'todo', executionMode: 'auto' }
}

describe('taskboard request validation', () => {
  it('rejects invalid enums, unknown types, and oversized labels', () => {
    const board = createBoard('project', '/tmp/project', '项目')
    expect(() => createItemFromBody(board, { ...itemBody(), priority: 'critical' })).toThrow('priority 无效')
    expect(() => createItemFromBody(board, { ...itemBody(), type: 'unknown' })).toThrow('type 不在当前看板类型中')
    expect(() => createItemFromBody(board, { ...itemBody(), labels: Array.from({ length: 21 }, (_, index) => String(index)) })).toThrow('最多 20 项')
  })

  it('supports clearing optional fields and rejects parent cycles', () => {
    const board = createBoard('project', '/tmp/project', '项目')
    const parent = createItemFromBody(board, itemBody('父任务'))
    board.items.push(parent)
    const child = createItemFromBody(board, { ...itemBody('子任务'), parentId: parent.id })
    board.items.push(child)
    expect(validateItemPatch(board, child, { parentId: null, iteration: null })).toEqual({ parentId: null, iteration: null })
    expect(() => validateItemPatch(board, parent, { parentId: child.id })).toThrow('循环')
  })

  it('does not remove settings that active or historical items still reference', () => {
    const board = createBoard('project', '/tmp/project', '项目')
    board.items.push(createItemFromBody(board, itemBody()))
    expect(() => validateSettings(board, {
      columns: board.columns.filter(column => column.id !== 'todo'),
      itemTypes: board.itemTypes
    })).toThrow('仍被工作项使用的环节')
  })

  it('creates AI 流程草稿：标题可空、强制第一列、desc 派生', () => {
    const board = createBoard('project', '/tmp/project', '项目')
    const requirement = '给系统加个登录功能，账号密码登录。'
    const draft = createItemFromBody(board, {
      type: 'task', title: '', desc: '', priority: 'medium', labels: [], status: 'in-dev',
      executionMode: 'auto', originalRequirement: requirement
    })
    expect(draft.title).toBe(requirement)
    expect(draft.desc).toBe(requirement)
    expect(draft.originalRequirement).toBe(requirement)
    expect(draft.creationState).toBe('draft')
    expect(draft.status).toBe('todo') // 强制第一列
    expect(() => createItemFromBody(board, { ...itemBody(), title: '' })).toThrow('标题或想法描述')
  })

  it('patches originalRequirement and rejects unrelated fields', () => {
    const board = createBoard('project', '/tmp/project', '项目')
    const draft = createItemFromBody(board, { ...itemBody('草稿'), originalRequirement: '原始需求' })
    board.items.push(draft)
    expect(validateItemPatch(board, draft, { originalRequirement: '改过的需求' }).originalRequirement).toBe('改过的需求')
    expect(() => validateItemPatch(board, draft, { aiAnalysis: {} })).toThrow('不支持的字段')
  })

  it('validates AI 分析方案体严格性', () => {
    const valid = {
      suggestedTitle: '登录',
      requirementUnderstanding: '理解',
      projectAnalysis: '现状',
      implementationPlan: ['步骤一'],
      affectedModules: ['auth.ts'],
      pendingQuestions: ['有效期？'],
      acceptanceCriteria: ['能登录']
    }
    expect(validateAiAnalysisBody(valid).implementationPlan).toEqual(['步骤一'])
    expect(() => validateAiAnalysisBody({ ...valid, requirementUnderstanding: '' })).toThrow('不能为空')
    expect(() => validateAiAnalysisBody({ ...valid, implementationPlan: 'not-array' })).toThrow('字符串数组')
    expect(() => validateAiAnalysisBody({ ...valid, acceptanceCriteria: [{ bad: true }] })).toThrow('必须是字符串')
    expect(() => validateAiAnalysisBody(undefined)).toThrow('analysis 必须是对象')
  })

  it('validates task dependencies：自引用/重复/越界/无效类型/不存在任务', () => {
    const board = createBoard('project', '/tmp/project', '项目')
    const a = createItemFromBody(board, itemBody('任务 A'))
    const b = createItemFromBody(board, itemBody('任务 B'))
    board.items.push(a, b)
    // 有效列表原样接受（before/after/parallel）
    const c = createItemFromBody(board, {
      ...itemBody('任务 C'),
      dependencies: [{ taskId: a.id, type: 'before' }, { taskId: b.id, type: 'after' }]
    })
    expect(c.dependencies).toEqual([{ taskId: a.id, type: 'before' }, { taskId: b.id, type: 'after' }])
    // 不传 / 空数组 → 无依赖
    expect(createItemFromBody(board, itemBody('无依赖')).dependencies).toBeUndefined()
    expect(createItemFromBody(board, { ...itemBody('空数组'), dependencies: [] }).dependencies).toBeUndefined()
    // 自引用（PATCH 路径）→ 400
    expect(() => validateItemPatch(board, a, { dependencies: [{ taskId: a.id, type: 'after' }] })).toThrow('不能依赖自身')
    // 重复关联同一任务 → 400
    expect(() => validateItemPatch(board, a, { dependencies: [{ taskId: b.id, type: 'before' }, { taskId: b.id, type: 'after' }] })).toThrow('不能重复关联')
    // 目标不在当前看板 → 400
    expect(() => validateItemPatch(board, a, { dependencies: [{ taskId: 'nope', type: 'after' }] })).toThrow('不在当前看板中')
    // 无效类型 → 400
    expect(() => validateItemPatch(board, a, { dependencies: [{ taskId: b.id, type: 'during' }] })).toThrow('type 无效')
    // null 清空依赖
    expect(validateItemPatch(board, a, { dependencies: null })).toEqual({ dependencies: null })
    // 最多 10 项
    const others = Array.from({ length: 10 }, (_, index) => createItemFromBody(board, itemBody(`依赖目标 ${index}`)))
    board.items.push(...others)
    const ten = others.map(task => ({ taskId: task.id, type: 'after' }))
    expect(validateItemPatch(board, a, { dependencies: ten }).dependencies).toHaveLength(10)
    expect(() => validateItemPatch(board, a, { dependencies: [...ten, { taskId: b.id, type: 'after' }] })).toThrow('最多 10 项')
  })

  it('normalizePreviewUrls 把 localhost 完整地址归一化为相对路径（预览基地址由看板统一管理）', () => {
    expect(normalizePreviewUrls(['http://localhost:5174/about/', '/blog/'])).toEqual(['/about/', '/blog/'])
    expect(normalizePreviewUrls(['http://127.0.0.1:4300/now/'])).toEqual(['/now/'])
    expect(normalizePreviewUrls(['http://localhost:5174'])).toEqual(['/'])
    expect(normalizePreviewUrls(['https://example.com/docs/guide'])).toEqual(['https://example.com/docs/guide'])
    expect(normalizePreviewUrls(['http://localhost:5174/paths?a=1&b=2'])).toEqual(['/paths?a=1&b=2'])
    expect(normalizePreviewUrls([])).toBeUndefined()
    expect(() => normalizePreviewUrls(['not-a-url'])).toThrow('无效地址')
  })
})
