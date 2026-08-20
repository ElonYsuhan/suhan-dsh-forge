import { randomUUID } from 'node:crypto'
import { HttpError } from './http.ts'
import type { AiAnalysis, Board, ColumnDef, ExecutionMode, ItemTypeDef, Priority, WorkItem } from './shared/types.ts'

const PRIORITIES = new Set<Priority>(['low', 'medium', 'high', 'urgent'])
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const COLOR = /^#[0-9a-fA-F]{6}$/

function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text (value: unknown, field: string, max: number, allowEmpty = true): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} 必须是字符串`)
  const normalized = value.trim()
  if (!allowEmpty && normalized === '') throw new HttpError(400, `${field} 不能为空`)
  if (normalized.length > max) throw new HttpError(400, `${field} 超过 ${max} 字符限制`)
  return normalized
}

function labels (value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, 'labels 必须是最多 20 项的字符串数组')
  const normalized = value.map(label => text(label, 'label', 64, false))
  return [...new Set(normalized)]
}

function priority (value: unknown, useDefault = true): Priority {
  if (value === undefined && useDefault) return 'medium'
  if (typeof value !== 'string' || !PRIORITIES.has(value as Priority)) throw new HttpError(400, 'priority 无效')
  return value as Priority
}

function itemType (board: Board, value: unknown, useDefault = true): string {
  const fallback = board.itemTypes[0]?.key ?? 'task'
  const candidate = value === undefined && useDefault ? fallback : text(value, 'type', 64, false)
  if (!board.itemTypes.some(type => type.key === candidate)) throw new HttpError(400, 'type 不在当前看板类型中')
  return candidate
}

function status (board: Board, value: unknown, useDefault = true): string {
  const fallback = board.columns[0]?.id ?? 'todo'
  const candidate = value === undefined && useDefault ? fallback : text(value, 'status', 64, false)
  if (!board.columns.some(column => column.id === candidate)) throw new HttpError(400, 'status 不在当前看板环节中')
  return candidate
}

function parent (board: Board, itemId: string | undefined, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const candidate = text(value, 'parentId', 128, false)
  if (candidate === itemId) throw new HttpError(400, '工作项不能以自身为父级')
  const byId = new Map(board.items.map(item => [item.id, item]))
  const target = byId.get(candidate)
  if (target === undefined || target.archived) throw new HttpError(400, 'parentId 指向的活动工作项不存在')
  const seen = new Set<string>()
  let cursor: WorkItem | undefined = target
  while (cursor !== undefined) {
    if (cursor.id === itemId) throw new HttpError(400, 'parentId 会形成循环追溯关系')
    if (seen.has(cursor.id)) throw new HttpError(400, '现有追溯关系已形成循环')
    seen.add(cursor.id)
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId)
  }
  return candidate
}

/** 首个非空行。 */
function firstLineOf (value: string): string {
  return value.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? ''
}

export function createItemFromBody (board: Board, body: unknown): WorkItem {
  if (!isObject(body)) throw new HttpError(400, '请求体必须是对象')
  const now = new Date().toISOString()
  const mode: ExecutionMode = body.executionMode === 'review' ? 'review' : 'auto'
  // AI 创建流程：标题可空（AI 分析后建议），原始需求即描述；
  // 新工作项一律落在第一列（创意想法），其他列不支持新建。
  const requirement = body.originalRequirement === undefined
    ? undefined
    : text(body.originalRequirement, 'originalRequirement', 20_000, false)
  const desc = requirement ?? (body.desc === undefined ? '' : text(body.desc, 'desc', 20_000))
  const fallbackTitle = firstLineOf(desc).slice(0, 200)
  const title = body.title === undefined || body.title === null || String(body.title).trim() === ''
    ? fallbackTitle
    : text(body.title, 'title', 200, false)
  if (title === '') throw new HttpError(400, '请填写标题或想法描述')
  return {
    id: randomUUID(),
    type: itemType(board, body.type),
    title,
    desc,
    originalRequirement: requirement,
    creationState: requirement === undefined ? undefined : 'draft',
    priority: priority(body.priority),
    labels: labels(body.labels),
    status: board.columns[0]?.id ?? 'todo',
    parentId: parent(board, undefined, body.parentId),
    iteration: body.iteration === undefined || body.iteration === null || body.iteration === '' ? undefined : text(body.iteration, 'iteration', 120, false),
    executionMode: mode,
    executionState: 'idle',
    timeline: [],
    createdAt: now,
    updatedAt: now,
    archived: false
  }
}

export interface ValidItemPatch {
  title?: string
  desc?: string
  originalRequirement?: string
  type?: string
  priority?: Priority
  labels?: string[]
  parentId?: string | null
  iteration?: string | null
  executionMode?: ExecutionMode
  status?: string
  note?: string
}

export function validateItemPatch (board: Board, item: WorkItem, body: unknown): ValidItemPatch {
  if (!isObject(body)) throw new HttpError(400, '请求体必须是对象')
  const allowed = new Set(['title', 'desc', 'originalRequirement', 'type', 'priority', 'labels', 'parentId', 'iteration', 'executionMode', 'status', 'meta'])
  if (Object.keys(body).some(key => !allowed.has(key))) throw new HttpError(400, '请求体包含不支持的字段')
  const patch: ValidItemPatch = {}
  if ('title' in body) patch.title = text(body.title, 'title', 200, false)
  if ('desc' in body) patch.desc = text(body.desc, 'desc', 20_000)
  if ('originalRequirement' in body) patch.originalRequirement = text(body.originalRequirement, 'originalRequirement', 20_000, false)
  if ('type' in body) patch.type = itemType(board, body.type, false)
  if ('priority' in body) patch.priority = priority(body.priority, false)
  if ('labels' in body) patch.labels = labels(body.labels)
  if ('parentId' in body) patch.parentId = parent(board, item.id, body.parentId) ?? null
  if ('iteration' in body) patch.iteration = body.iteration === null || body.iteration === '' ? null : text(body.iteration, 'iteration', 120, false)
  if ('executionMode' in body) {
    if (body.executionMode !== 'auto' && body.executionMode !== 'review') throw new HttpError(400, 'executionMode 无效')
    patch.executionMode = body.executionMode
  }
  if ('status' in body) patch.status = status(board, body.status, false)
  if ('meta' in body) {
    if (!isObject(body.meta) || (body.meta.note !== undefined && typeof body.meta.note !== 'string')) throw new HttpError(400, 'meta.note 必须是字符串')
    if (body.meta.note !== undefined) patch.note = text(body.meta.note, 'meta.note', 2_000)
  }
  return patch
}

/** 校验确认方案页提交的结构化方案体（严格：确认时人工已看过全部字段）。 */
export function validateAiAnalysisBody (value: unknown): AiAnalysis {
  if (!isObject(value)) throw new HttpError(400, 'analysis 必须是对象')
  const list = (field: string): string[] => {
    const raw = value[field]
    if (!Array.isArray(raw) || raw.length > 100) throw new HttpError(400, `${field} 必须是最多 100 项的字符串数组`)
    return raw.map((entry, index) => text(entry, `${field}[${index}]`, 2_000, false))
  }
  const analysis: AiAnalysis = {
    requirementUnderstanding: text(value.requirementUnderstanding, 'requirementUnderstanding', 20_000, false),
    projectAnalysis: text(value.projectAnalysis, 'projectAnalysis', 20_000, false),
    implementationPlan: list('implementationPlan'),
    affectedModules: list('affectedModules'),
    pendingQuestions: list('pendingQuestions'),
    acceptanceCriteria: list('acceptanceCriteria')
  }
  if (value.suggestedTitle !== undefined) analysis.suggestedTitle = text(value.suggestedTitle, 'suggestedTitle', 200, false)
  return analysis
}

function uniqueIds (values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new HttpError(400, `${field} 不能重复`)
}

export function validateSettings (board: Board, body: unknown): { columns: ColumnDef[]; itemTypes: ItemTypeDef[] } {
  if (!isObject(body)) throw new HttpError(400, '请求体必须是对象')
  if (!Array.isArray(body.columns) || body.columns.length === 0 || body.columns.length > 32) throw new HttpError(400, 'columns 必须包含 1 到 32 个环节')
  if (!Array.isArray(body.itemTypes) || body.itemTypes.length === 0 || body.itemTypes.length > 32) throw new HttpError(400, 'itemTypes 必须包含 1 到 32 个类型')
  const columns = body.columns.map(value => {
    if (!isObject(value)) throw new HttpError(400, 'column 必须是对象')
    const id = text(value.id, 'column.id', 64, false)
    if (!IDENTIFIER.test(id)) throw new HttpError(400, 'column.id 格式无效')
    return { id, label: text(value.label, 'column.label', 80, false) }
  })
  const itemTypes = body.itemTypes.map(value => {
    if (!isObject(value)) throw new HttpError(400, 'itemType 必须是对象')
    const key = text(value.key, 'itemType.key', 64, false)
    if (!IDENTIFIER.test(key)) throw new HttpError(400, 'itemType.key 格式无效')
    const color = text(value.color, 'itemType.color', 7, false)
    if (!COLOR.test(color)) throw new HttpError(400, 'itemType.color 必须是六位十六进制颜色')
    return { key, label: text(value.label, 'itemType.label', 80, false), color }
  })
  uniqueIds(columns.map(column => column.id), 'column.id')
  uniqueIds(itemTypes.map(type => type.key), 'itemType.key')
  const columnIds = new Set(columns.map(column => column.id))
  const typeIds = new Set(itemTypes.map(type => type.key))
  if (board.items.some(item => !columnIds.has(item.status))) throw new HttpError(409, '不能删除仍被工作项使用的环节')
  if (board.items.some(item => !typeIds.has(item.type))) throw new HttpError(409, '不能删除仍被工作项使用的类型')
  return { columns, itemTypes }
}
