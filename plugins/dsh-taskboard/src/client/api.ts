/**
 * 需求看板 REST 客户端（同源，无 CORS）。
 */
import type { Board, ColumnDef, ExecutionMode, ItemTypeDef, Priority, WorkItem } from '../shared/types.ts'

/** workspace 元信息（来自 ctx.workspaceRegistry） */
export interface WorkspaceMeta {
  id: string
  path: string
  title: string
  sessionCount: number
}

/** 看板全量响应 */
export interface BoardsResponse {
  workspaces: WorkspaceMeta[]
  boards: Record<string, Board>
}

/** 当前工作区按需分页的历史任务。 */
export interface HistoryResponse {
  items: WorkItem[]
  total: number
}

/** 新建/编辑工作项载荷 */
export interface ItemInput {
  type: string
  title: string
  desc: string
  priority: Priority
  labels: string[]
  parentId?: string | undefined
  iteration?: string | undefined
  status: string
  executionMode: ExecutionMode
}

/** 项目看板列表（同步 workspace 注册表） */
export async function fetchBoards (): Promise<BoardsResponse> {
  const res = await fetch('/taskboard/boards')
  if (!res.ok) throw new Error(`taskboard: boards failed (${res.status})`)
  return res.json() as Promise<BoardsResponse>
}

/** 只在打开历史面板时加载，避免常规轮询携带不断增长的归档数据。 */
export async function fetchHistory (key: string, offset = 0, limit = 50): Promise<HistoryResponse> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/history?${query.toString()}`)
  if (!res.ok) throw new Error(`taskboard: history failed (${res.status})`)
  return res.json() as Promise<HistoryResponse>
}

/** 新建工作项 */
export async function createItem (key: string, input: ItemInput): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) throw new Error(`taskboard: create failed (${res.status})`)
  return (await res.json() as { item: WorkItem }).item
}

/** 更新工作项（含拖拽流转） */
export async function updateItem (key: string, id: string, patch: Partial<ItemInput> & { meta?: { note?: string } }): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
  if (!res.ok) throw new Error(`taskboard: update failed (${res.status})`)
  return (await res.json() as { item: WorkItem }).item
}

/** 删除结果；执行过的任务会先尝试回退。 */
export interface DeleteItemResult {
  item: WorkItem
  rolledBack: boolean
  warning?: string | undefined
}

/** 随时删除工作项；有关联会话时由 Host 负责停止、回退和归档。 */
export async function deleteItem (key: string, id: string): Promise<DeleteItemResult> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
  const body = await res.json().catch(() => ({})) as DeleteItemResult & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `taskboard: delete failed (${res.status})`)
  return body
}

/** 执行工作项：创建/复用 agent 会话并下发任务 */
export async function runItem (key: string, id: string): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}/run`, {
    method: 'POST'
  })
  if (!res.ok) throw new Error(`taskboard: run failed (${res.status})`)
  return (await res.json() as { item: WorkItem }).item
}

/** 强制停止任务，恢复执行前 Git 基线并归档会话与卡片。 */
export async function forceCloseItem (key: string, id: string): Promise<WorkItem> {
  return executeAction(key, id, 'force-close')
}

/** 批准重大任务当前环节并在同一会话继续。 */
export async function approveItem (key: string, id: string): Promise<WorkItem> {
  return executeAction(key, id, 'approve')
}

/** 退回重大任务当前环节并要求在同一会话修订。 */
export async function rejectItem (key: string, id: string): Promise<WorkItem> {
  return executeAction(key, id, 'reject')
}

/** 人工确认最终交付，授权 Agent 运行检查并提交本任务代码。 */
export async function confirmDelivery (key: string, id: string): Promise<WorkItem> {
  return executeAction(key, id, 'confirm-delivery')
}

async function executeAction (key: string, id: string, action: string): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}/${action}`, {
    method: 'POST'
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `taskboard: ${action} failed (${res.status})`)
  }
  return (await res.json() as { item: WorkItem }).item
}

/** 保存看板设置（自定义环节/类型） */
export async function saveSettings (key: string, settings: { columns?: ColumnDef[]; itemTypes?: ItemTypeDef[] }): Promise<Board> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  })
  if (!res.ok) throw new Error(`taskboard: settings failed (${res.status})`)
  return (await res.json() as { board: Board }).board
}
