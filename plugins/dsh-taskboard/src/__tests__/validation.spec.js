import { describe, expect, it } from 'vitest'
import { createBoard } from '../shared/types.ts'
import { createItemFromBody, validateItemPatch, validateSettings } from '../validation.ts'

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
})
