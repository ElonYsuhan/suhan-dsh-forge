/**
 * 需求看板 REST 客户端（同源，无 CORS）。
 */
import type { AiAnalysis, Board, ColumnDef, ExecutionMode, ItemTypeDef, Priority, TaskDependency, WorkItem } from '../shared/types.ts'

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
  originalRequirement?: string | undefined
  priority: Priority
  labels: string[]
  parentId?: string | null | undefined
  iteration?: string | null | undefined
  status: string
  executionMode: ExecutionMode
  /** 任务依赖（可选）：编辑时提交变更后的依赖列表；null 表示清空。 */
  dependencies?: TaskDependency[] | null | undefined
}

async function jsonResponse<T> (res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => ({})) as Partial<T> & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `${fallback} (${res.status})`)
  return body as T
}

/** 项目看板列表（同步 workspace 注册表） */
export async function fetchBoards (): Promise<BoardsResponse> {
  const res = await fetch('/taskboard/boards')
  return jsonResponse<BoardsResponse>(res, 'taskboard: boards failed')
}

/** 只在打开历史面板时加载，避免常规轮询携带不断增长的归档数据。 */
export async function fetchHistory (key: string, offset = 0, limit = 50): Promise<HistoryResponse> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/history?${query.toString()}`)
  return jsonResponse<HistoryResponse>(res, 'taskboard: history failed')
}

/** 释放已完成任务遗留的临时 Workspace/worktree，保留会话聊天日志。 */
export async function cleanupHistoryWorkspace (key: string, id: string): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/history/${encodeURIComponent(id)}/cleanup`, {
    method: 'POST'
  })
  const body = await jsonResponse<{ item?: WorkItem }>(res, 'taskboard: history cleanup failed')
  if (body.item === undefined) throw new Error('taskboard: history cleanup response missing item')
  return body.item
}

/** 新建工作项 */
export async function createItem (key: string, input: ItemInput): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  const body = await jsonResponse<{ item?: WorkItem }>(res, 'taskboard: create failed')
  if (body.item === undefined) throw new Error('taskboard: create response missing item')
  return body.item
}

/** 更新工作项（含拖拽流转） */
export async function updateItem (key: string, id: string, patch: Partial<ItemInput> & { meta?: { note?: string } }): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
  const body = await jsonResponse<{ item?: WorkItem }>(res, 'taskboard: update failed')
  if (body.item === undefined) throw new Error('taskboard: update response missing item')
  return body.item
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
  return jsonResponse<DeleteItemResult>(res, 'taskboard: delete failed')
}

/** 执行工作项：创建/复用 agent 会话并下发任务 */
export async function runItem (key: string, id: string): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}/run`, {
    method: 'POST'
  })
  const body = await jsonResponse<{ item?: WorkItem }>(res, 'taskboard: run failed')
  if (body.item === undefined) throw new Error('taskboard: run response missing item')
  return body.item
}

/** 启动/重新启动方案生成（创建或复用只读方案生成会话）。 */
export async function analyzeItem (key: string, id: string, supplement?: string): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(supplement === undefined || supplement.trim() === '' ? {} : { supplement })
  })
  const body = await jsonResponse<{ item?: WorkItem }>(res, 'taskboard: analyze failed')
  if (body.item === undefined) throw new Error('taskboard: analyze response missing item')
  return body.item
}

/** 确认并冻结方案，自动开始执行。 */
export async function confirmPlanItem (key: string, id: string, input: { title?: string; analysis: AiAnalysis }): Promise<WorkItem> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}/confirm-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  const body = await jsonResponse<{ item?: WorkItem }>(res, 'taskboard: confirm-plan failed')
  if (body.item === undefined) throw new Error('taskboard: confirm-plan response missing item')
  return body.item
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
  const body = await jsonResponse<{ item?: WorkItem }>(res, `taskboard: ${action} failed`)
  if (body.item === undefined) throw new Error(`taskboard: ${action} response missing item`)
  return body.item
}

/** 任务实时预览探测结果：url 就绪 / pending（依赖安装中、启动中）/ 失败原因。 */
export interface LivePreviewResponse {
  url: string | null
  pending: boolean
  reason?: string | undefined
}

/** 任务实时预览：确保执行中任务的工作区 dev server 运行并返回预览地址（端口租约）。 */
export async function fetchLivePreview (key: string, id: string): Promise<LivePreviewResponse> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/items/${encodeURIComponent(id)}/live-preview`)
  return jsonResponse<LivePreviewResponse>(res, 'taskboard: live-preview failed')
}

/** 页面预览基地址响应：baseUrl 为空时 error 说明原因。 */
export interface PreviewBaseResponse {
  baseUrl: string | null
  error?: string | undefined
}

/** 项目 dev server 基地址：探测/启动后返回，用于把相对预览路径解析为可打开的真实页面。 */
export async function fetchPreviewBase (key: string): Promise<PreviewBaseResponse> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/preview-base`)
  return jsonResponse<PreviewBaseResponse>(res, 'taskboard: preview-base failed')
}

/** 保存看板设置（自定义环节/类型） */
export async function saveSettings (key: string, settings: { columns?: ColumnDef[]; itemTypes?: ItemTypeDef[] }): Promise<Board> {
  const res = await fetch(`/taskboard/boards/${encodeURIComponent(key)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  })
  const body = await jsonResponse<{ board?: Board }>(res, 'taskboard: settings failed')
  if (body.board === undefined) throw new Error('taskboard: settings response missing board')
  return body.board
}
