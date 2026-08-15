/**
 * 需求看板插件，host 半：多项目看板 REST 服务。
 *
 * - 项目来源：DSH workspace 注册表（ctx.workspaceRegistry）
 * - 数据落盘：$DSH_HOME/storages/dsh-taskboard/boards.json（version 2）
 * - 任务执行：POST /boards/:key/items/:id/run 创建/复用 agent 会话并 followup，
 *   工作项记录 sessionId（任务 ↔ 聊天页档案）
 *
 * 路由（prefix /taskboard）：
 *   GET    /boards                         全部项目看板（同步 workspace 注册表）
 *   GET    /boards/:key/items              工作项列表
 *   POST   /boards/:key/items              新建工作项
 *   PATCH  /boards/:key/items/:id          更新（含拖拽流转 → timeline.moved）
 *   DELETE /boards/:key/items/:id          随时删除（执行过则停止、回退、归档会话）
 *   POST   /boards/:key/items/:id/run      执行（建会话 + followup）
 *   POST   /boards/:key/items/:id/force-close 强制停止、回退并归档
 *   PUT    /boards/:key/settings           { columns?, itemTypes? } 自定义环节/类型
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { restoreGitCheckpoint } from './gitCheckpoint.ts'
import { HttpError, readJsonBody } from './http.ts'
import { createBoard, executionModeOf, executionStateOf, type Board, type BoardsFile, type ColumnDef, type ExecutionState, type TimelineEntry, type WorkItem } from './shared/types.ts'
import { readStoredBoards, taskboardDataPaths, TaskboardDataError } from './storage.ts'
import { commitTaskWorkspace, deleteTaskBranch, discardTaskWorkspace, integrateTaskWorkspace, prepareTaskWorkspace, resolveGitRoot, TaskWorkspacePreconditionError } from './taskWorkspace.ts'
import { createItemFromBody, validateItemPatch, validateSettings } from './validation.ts'

/**
 * Host services this plugin requires. Cordis only resolves `ctx` property
 * access for names declared here — without it the proxy throws
 * `cannot get property "webServer" without inject` at load time.
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'agents', 'agentDefaultModel', 'agentPresets', 'tools']

/** 数据文件：默认 $DSH_HOME/storages/dsh-taskboard/boards.json；环境变量可覆盖。 */
const DATA_PATHS = taskboardDataPaths(import.meta.url)
const DATA_FILE = DATA_PATHS.dataFile

/** 任务 worktree 位于运行数据目录，不进入项目仓库或发布包。 */
const WORKTREES_ROOT = resolve(dirname(DATA_FILE), 'worktrees')

/** 活动执行句柄（createAgent 返回的 owner 能力）：归档时停止 agent 并归档会话。 */
const agentHandles = new Map<string, AgentHandle>()

/** 内存缓存：避免每次请求读盘 */
let cache: BoardsFile | null = null

/** 同一任务的状态转换串行；不同任务及其 Agent 仍可并行。 */
const operationLocks = new Map<string, Promise<void>>()

/** 原子文件写入仍需顺序化，避免较慢的旧快照最后落盘。 */
let saveTail: Promise<void> = Promise.resolve()

interface LifecycleState {
  active: boolean
}

async function withLock<T> (key: string, action: () => Promise<T>): Promise<T> {
  const previous = operationLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  const tail = previous.then(() => gate)
  operationLocks.set(key, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (operationLocks.get(key) === tail) operationLocks.delete(key)
  }
}

async function loadBoards (): Promise<BoardsFile> {
  if (cache !== null) return cache
  const stored = await readStoredBoards(DATA_PATHS)
  if (stored === null) {
    cache = { version: 2, boards: {} }
    await saveBoards(cache)
  } else {
    cache = stored.file
    if (stored.source !== 'primary') await saveBoards(cache, stored.source !== 'backup')
  }
  return cache
}

/** 原子落盘（tmp + rename） */
async function saveBoards (file: BoardsFile, backupCurrent = true): Promise<void> {
  cache = file
  const serialized = JSON.stringify(file, null, 2)
  const write = saveTail.then(async () => {
    await mkdir(dirname(DATA_FILE), { recursive: true })
    const tmp = `${DATA_FILE}.${randomUUID()}.tmp`
    await writeFile(tmp, serialized, 'utf8')
    if (backupCurrent) await copyFile(DATA_FILE, `${DATA_FILE}.bak`).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await rename(tmp, DATA_FILE)
  })
  saveTail = write.catch(() => {})
  await write
}

/** JSON 响应 */
function send (res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Host 诊断只保留错误链，移除常见凭证与本机绝对路径，并限制单条长度。 */
function diagnosticError (value: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = value
  while (current !== undefined && current !== null && !seen.has(current) && parts.length < 4) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`)
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join(' <- ')
    .replace(/\/Users\/[^/\s]+\//g, '/Users/<redacted>/')
    .replace(/\b(Bearer\s+|(?:api[-_]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2_000)
}

function isTaskWorkspacePath (path: string): boolean {
  const child = relative(WORKTREES_ROOT, resolve(path))
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** 注册 Agent 实际 cwd，并用原项目/任务标题表达逻辑归属。 */
async function attachTaskSession (
  ctx: Context,
  workspace: NonNullable<WorkItem['taskWorkspace']>,
  sessionId: string,
  title: string
): Promise<Workspace> {
  const registered = await ctx.workspaceRegistry.resolveByPath(workspace.path) ??
    await ctx.workspaceRegistry.create(workspace.path, title)
  workspace.workspaceId = registered.id
  try {
    await registered.attachSession(SessionId(sessionId))
    return registered
  } catch (error) {
    await ctx.workspaceRegistry.delete(registered.id).catch(() => {})
    delete workspace.workspaceId
    throw error
  }
}

/** 分离会话并删除插件创建的临时 Workspace；两个清理步骤互不阻断。 */
async function removeTaskWorkspaceRegistration (
  ctx: Context,
  workspace: WorkItem['taskWorkspace'],
  sessionId?: string
): Promise<void> {
  if (workspace?.workspaceId === undefined) return
  const id = WorkspaceId(workspace.workspaceId)
  const registered = ctx.workspaceRegistry.get(id)
  const errors: unknown[] = []
  if (registered !== undefined && sessionId !== undefined) {
    await registered.detachSession(SessionId(sessionId)).catch(error => errors.push(error))
  }
  await ctx.workspaceRegistry.delete(id).catch(error => errors.push(error))
  delete workspace.workspaceId
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'task workspace registration cleanup failed')
}

/** 重启或旧版本升级后，为仍在活动的隔离会话恢复真实 Workspace 归属。 */
async function recoverTaskWorkspaceRegistrations (
  ctx: Context,
  file: BoardsFile,
  report: (error: unknown) => void
): Promise<void> {
  let changed = false
  for (const board of Object.values(file.boards)) {
    for (const item of board.items) {
      if (item.archived || item.sessionId === undefined || item.taskWorkspace === undefined) continue
      if (item.taskWorkspace.workspaceId !== undefined &&
          ctx.workspaceRegistry.get(WorkspaceId(item.taskWorkspace.workspaceId)) !== undefined) continue
      try {
        await attachTaskSession(ctx, item.taskWorkspace, item.sessionId, `${board.projectTitle} · ${item.title}`)
        changed = true
      } catch (error) {
        report(error)
      }
    }
  }
  if (changed) await saveBoards(file)
}

/** 确保某项目存在看板（同步 workspace 注册表） */
function ensureBoard (file: BoardsFile, key: string, path: string, title: string): Board {
  let board = file.boards[key]
  if (board === undefined) {
    board = createBoard(key, path, title)
    file.boards[key] = board
  }
  return board
}

/** 读取单个工作项（不存在抛错） */
function findItem (board: Board, id: string): WorkItem {
  const item = board.items.find(i => i.id === id)
  if (item === undefined) throw new HttpError(404, '工作项不存在')
  return item
}

/** 追加时间线条目 */
function pushTimeline (item: WorkItem, entry: Omit<TimelineEntry, 'at'>): void {
  item.timeline.push({ at: new Date().toISOString(), ...entry })
}

/** DSH 默认模型服务的最小消费面，避免插件依赖 Host API 实现。 */
interface AgentDefaultModelLike {
  currentSelection: () => ModelSelection
}

/** DSH Agent preset 服务的最小消费面。 */
interface AgentPresetsLike {
  resolve: (id?: string) => Promise<{ id: string }>
  mount: (agentCtx: Context, id?: string) => Promise<unknown>
}

/** 取得 Web profile 的当前默认模型。 */
function currentModelSelection (ctx: Context): ModelSelection {
  const service = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  if (service === undefined) throw new Error('agentDefaultModel service is unavailable')
  return service.currentSelection()
}

/** 取得 Web profile 的 Agent preset 服务。 */
function agentPresets (ctx: Context): AgentPresetsLike {
  const service = ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (service === undefined) throw new Error('agentPresets service is unavailable')
  return service
}

/** 创建一个带正确模型选择的完整 Agent + Session。 */
async function createTaskAgent (ctx: Context, sessionId: string, cwd: string): Promise<AgentHandle> {
  const selection = currentModelSelection(ctx)
  const presets = agentPresets(ctx)
  const preset = await presets.resolve()
  return ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd, agentPreset: preset.id },
    agentOptions: selection,
    setup: async agentCtx => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, preset.id)
    }
  })
}

/** 取得 live Agent；进程重启后从持久化日志恢复同一会话。 */
async function resolveTaskAgent (ctx: Context, sessionId: string, presetId?: string): Promise<Agent> {
  const id = SessionId(sessionId)
  const live = ctx.agents.get(id)
  if (live !== undefined) return live
  const selection = currentModelSelection(ctx)
  const presets = agentPresets(ctx)
  const preset = await presets.resolve(presetId)
  const handle = await ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: selection,
    setup: async agentCtx => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, preset.id)
    }
  })
  agentHandles.set(sessionId, handle)
  return handle.agent
}

/** 生成一条普通用户 followup。 */
function followup (agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }))
}

/** 工作项所在环节的展示名。 */
function columnLabel (board: Board, status: string): string {
  return board.columns.find(column => column.id === status)?.label ?? status
}

/** 进入下一环节；已在最后一环节时返回 undefined。 */
function nextColumn (board: Board, item: WorkItem): ColumnDef | undefined {
  const index = board.columns.findIndex(column => column.id === item.status)
  return index < 0 ? board.columns[0] : board.columns[index + 1]
}

/** 更新时间戳。 */
function touch (board: Board, item: WorkItem): void {
  item.updatedAt = new Date().toISOString()
  board.updatedAt = item.updatedAt
}

/** 集成失败后生成一个显式、可追溯的冲突处理任务。 */
function createConflictItem (
  board: Board,
  source: WorkItem,
  sourceCommit: string,
  sourceBranch: string,
  reason: string
): WorkItem {
  const now = new Date().toISOString()
  const item: WorkItem = {
    id: randomUUID(),
    type: 'task',
    title: `处理集成冲突：${source.title}`,
    desc: [
      `原工作项 ${source.id} 已生成独立提交 ${sourceCommit}，但无法自动集成。`,
      `原因：${reason}`,
      '执行本任务时，请在独立 worktree 中运行 git cherry-pick --no-commit 指定提交，人工判断并解决冲突；不要直接修改项目主工作区。'
    ].join('\n'),
    priority: source.priority,
    labels: [...new Set([...source.labels, 'integration-conflict'])],
    status: board.columns[0]?.id ?? 'todo',
    parentId: source.parentId,
    iteration: source.iteration,
    executionMode: 'review',
    executionState: 'idle',
    integrationState: 'pending',
    conflictOf: source.id,
    conflictSourceCommit: sourceCommit,
    conflictSourceBranch: sourceBranch,
    timeline: [],
    createdAt: now,
    updatedAt: now,
    archived: false
  }
  pushTimeline(item, { action: 'created', to: item.status, note: `由工作项 ${source.id} 的集成冲突自动创建` })
  return item
}

/** 是否已有一条不能并发替换的执行。 */
function executionActive (state: ExecutionState): boolean {
  return state === 'running' || state === 'awaiting-review' || state === 'awaiting-delivery' || state === 'committing'
}

/** 构造首次执行指令。 */
function executionPrompt (board: Board, item: WorkItem): string {
  const mode = executionModeOf(item)
  const phase = columnLabel(board, item.status)
  return [
    `请执行以下工作项。项目：${board.projectTitle}；工作目录：${board.projectPath}。`,
    `【标题】${item.title}`,
    item.desc === '' ? '' : `【描述】${item.desc}`,
    item.iteration === undefined ? '' : `【迭代】${item.iteration}`,
    `【执行策略】${mode === 'review' ? '重大任务：每个环节必须人工审核' : '小任务：可自主逐环节推进'}`,
    `【当前环节】${phase}`,
    item.conflictSourceCommit === undefined
      ? '【Git 隔离】当前会话位于本任务独占 worktree；其他任务会在各自目录并行执行。'
      : `【冲突处理】先运行 git cherry-pick --no-commit ${item.conflictSourceCommit}，解决冲突并验证；不得创建提交，最终提交由看板完成。`,
    '',
    '必须遵守：',
    '- 先读取并遵守工作区内的工程指令。只处理本工作项，不覆盖或提交无关改动。',
    '- 每个环节都要在会话中给出可审核的结果，再调用 taskboard_progress(outcome="stage_complete", summary="本环节结果摘要")。',
    mode === 'review'
      ? '- 工具返回“结束本轮执行”后必须立即结束当前 turn；会话完全停稳后看板才会开放人工审核，不能自行进入下一环节。'
      : '- 每个 turn 最多完成一个环节。工具返回“结束本轮执行”后必须立即停止；会话停稳后看板才会流转，插件会另发下一环节的新 turn。',
    '- 遇到阻塞调用 taskboard_progress(outcome="blocked", summary="阻塞原因")。',
    '- 全程严禁 git commit、切换分支或操作项目主工作区；看板会在人工确认交付后自动生成任务提交并串行集成。',
    '- 完成全部环节和质量检查后调用 taskboard_progress(outcome="delivery_ready", summary="交付物与验证摘要")，然后等待人工确认。'
  ].filter(line => line !== '').join('\n')
}

/**
 * Agent 在工具调用后仍可能继续输出；必须等整轮会话停稳，才能开放人工审核。
 * 延迟期间若任务已阻塞、切换环节或被归档，则放弃这次过期的审核状态。
 */
function publishReviewAfterAgentIdle (
  agent: Agent,
  sessionId: string,
  stageStatus: string,
  note: string,
  lifecycle: LifecycleState
): void {
  const waitAndPublish = async (): Promise<void> => {
    await agent.whenIdle()
    if (!lifecycle.active) return
    const file = await loadBoards()
    for (const board of Object.values(file.boards)) {
      const item = board.items.find(candidate => candidate.sessionId === sessionId && !candidate.archived)
      if (item === undefined) continue
      await withLock(`item:${board.projectKey}:${item.id}`, async () => {
        if (!lifecycle.active) return
        if (item.archived || executionStateOf(item) !== 'running' || item.status !== stageStatus) return
        item.executionState = 'awaiting-review'
        item.reviewSummary = note
        pushTimeline(item, { action: 'note', note: `环节产出待人工审核：${note}` })
        touch(board, item)
        await saveBoards(file)
      })
      return
    }
  }
  waitAndPublish().catch(() => {
    // Agent/插件卸载期间不再发布审核状态；保持 running，避免错误开放审批。
  })
}

/**
 * 小任务也必须等当前 turn 完全结束后才能流转；流转成功后由插件开启下一轮。
 * 同一 turn 的重复 stage_complete 都携带相同 stageStatus，只有第一个能通过校验。
 */
function advanceAutoStageAfterAgentIdle (
  agent: Agent,
  sessionId: string,
  stageStatus: string,
  note: string,
  lifecycle: LifecycleState
): void {
  const waitAndAdvance = async (): Promise<void> => {
    await agent.whenIdle()
    if (!lifecycle.active) return
    const file = await loadBoards()
    for (const board of Object.values(file.boards)) {
      const item = board.items.find(candidate => candidate.sessionId === sessionId && !candidate.archived)
      if (item === undefined) continue
      await withLock(`item:${board.projectKey}:${item.id}`, async () => {
        if (!lifecycle.active) return
        if (item.archived || executionStateOf(item) !== 'running' || item.status !== stageStatus) return
        const next = nextColumn(board, item)
        if (next === undefined) {
          item.executionState = 'awaiting-delivery'
          item.deliverySummary = note
          pushTimeline(item, { action: 'note', note: `全部环节完成，等待人工确认交付：${note}` })
          touch(board, item)
          await saveBoards(file)
          return
        }
        pushTimeline(item, { action: 'moved', from: item.status, to: next.id, note })
        item.status = next.id
        touch(board, item)
        await saveBoards(file)
        followup(agent, `上一环节已在会话停稳后结算。现在进入「${next.label}」环节。请先完成该环节的真实工作并在会话中给出结果；每个 turn 只能在末尾调用一次 taskboard_progress(outcome="stage_complete")。`)
      })
      return
    }
  }
  waitAndAdvance().catch(() => {
    // Agent/插件卸载期间不流转，保持原环节，避免空转或重复推进。
  })
}

/** Agent 报告提交成功后，等待当前 turn 落盘并释放 live handle。 */
function retireDeliveredAgent (ctx: Context, sessionId: string, agent: Agent, lifecycle: LifecycleState): void {
  (async () => {
    await agent.whenIdle()
    if (!lifecycle.active) return
    await ctx.sessions.flush(agent.session)
    const handle = agentHandles.get(sessionId)
    if (handle !== undefined) {
      await handle.dispose()
      agentHandles.delete(sessionId)
    }
  })().catch(() => {
    // 会话已完成并归档；清理由 DSH/插件卸载生命周期继续兜底。
  })
}

/** 停止持有任务会话的资源并归档；Git 结果已经落盘时，归档失败只记录不回滚提交。 */
async function closeTaskSession (ctx: Context, item: WorkItem): Promise<string | undefined> {
  const sessionId = item.sessionId
  if (sessionId === undefined) return undefined
  const errors: string[] = []
  try {
    const live = ctx.agents.get(SessionId(sessionId))
    if (live !== undefined) {
      await live.whenIdle()
      await ctx.sessions.flush(live.session)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const handle = agentHandles.get(sessionId)
    if (handle !== undefined) {
      await handle.dispose()
      agentHandles.delete(sessionId)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    await ctx.workspaceRegistry.archiveSession(SessionId(sessionId))
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    await removeTaskWorkspaceRegistration(ctx, item.taskWorkspace, sessionId)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return errors.length === 0 ? undefined : errors.join('；')
}

/** 自动提交任务 worktree，并在仓库级短锁内集成到目标分支。 */
async function finalizeIsolatedTask (ctx: Context, file: BoardsFile, board: Board, item: WorkItem): Promise<void> {
  const workspace = item.taskWorkspace
  if (workspace === undefined) throw new Error('任务缺少隔离 worktree，不能使用自动集成流程')

  item.executionState = 'committing'
  item.integrationState = 'integrating'
  pushTimeline(item, { action: 'note', note: '人工确认交付；看板开始自动提交并串行集成' })
  touch(board, item)
  await saveBoards(file)

  let sourceCommit: string
  try {
    sourceCommit = await commitTaskWorkspace(workspace, item.id, item.title)
  } catch (error) {
    item.executionState = 'blocked'
    item.integrationState = 'pending'
    pushTimeline(item, { action: 'note', note: `自动创建任务提交失败：${error instanceof Error ? error.message : String(error)}` })
    touch(board, item)
    await saveBoards(file)
    throw error
  }

  const result = await withLock(`repository:${workspace.root}`, async () => integrateTaskWorkspace(workspace))
    .catch(error => ({
      kind: 'conflicted' as const,
      sourceCommit,
      reason: `自动集成过程异常终止：${error instanceof Error ? error.message : String(error)}`
    }))
  if (result.kind === 'conflicted') {
    const conflict = createConflictItem(board, item, result.sourceCommit, workspace.branch, result.reason)
    board.items.push(conflict)
    item.commitRef = result.sourceCommit
    item.conflictTaskId = conflict.id
    item.integrationState = 'conflicted'
    item.executionState = 'failed'
    item.archived = true
    pushTimeline(item, { action: 'note', note: `自动集成受阻；已创建冲突处理任务 ${conflict.id}：${result.reason}` })
    const sessionWarning = await closeTaskSession(ctx, item)
    await discardTaskWorkspace(workspace, true)
    if (sessionWarning !== undefined) pushTimeline(item, { action: 'note', note: `Git 冲突现场已保存，但会话归档失败：${sessionWarning}` })
    touch(board, item)
    await saveBoards(file)
    return
  }

  item.commitRef = result.commit
  item.integrationState = 'merged'
  item.executionState = 'idle'
  item.archived = true
  const finalColumn = board.columns.at(-1)
  if (finalColumn !== undefined && item.status !== finalColumn.id) {
    pushTimeline(item, { action: 'moved', from: item.status, to: finalColumn.id, note: '任务提交已自动集成' })
    item.status = finalColumn.id
  }
  pushTimeline(item, { action: 'note', note: `自动提交并集成完成：${result.commit}` })
  const sessionWarning = await closeTaskSession(ctx, item)
  await discardTaskWorkspace(workspace)
  if (item.conflictSourceBranch !== undefined) await deleteTaskBranch(workspace.root, item.conflictSourceBranch)
  if (sessionWarning !== undefined) pushTimeline(item, { action: 'note', note: `代码已集成，但会话归档失败：${sessionWarning}` })
  touch(board, item)
  await saveBoards(file)
}

/**
 * 需求看板插件 body，host 半。
 * @param ctx - host context（webServer / workspaceRegistry / sessions / agents / tools）。
 */
export function apply (ctx: Context): void {
  const lifecycle: LifecycleState = { active: true }
  const logger = ctx.logger('dsh-taskboard')
  const reportError = (error: unknown): string => {
    const errorId = randomUUID().slice(0, 8)
    logger.error('request failed [%s]', errorId, error)
    process.stderr.write(`[dsh-taskboard] request failed [${errorId}]: ${diagnosticError(error)}\n`)
    return errorId
  }
  cache = null

  ctx.effect(() => async () => {
    lifecycle.active = false
    const handles = [...agentHandles.values()]
    agentHandles.clear()
    await Promise.allSettled(handles.map(async handle => handle.dispose()))
    await saveTail.catch(() => {})
    cache = null
  }, 'taskboard: agent handles')

  // Agent 只能通过这个工具改变工作项执行状态。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_progress',
    description: '向需求看板汇报环节完成、阻塞、待交付或已提交。重大任务会停在每个环节等待人工审核；任何任务最终都必须等待人工确认交付。',
    parameters: {
      outcome: {
        type: 'string',
        enum: ['stage_complete', 'blocked', 'delivery_ready', 'delivered'],
        required: true,
        description: 'stage_complete=当前环节产出完成；blocked=遇到阻塞；delivery_ready=交付物已就绪；delivered=人工确认后已完成代码提交'
      },
      summary: { type: 'string', description: '本次结果摘要（供人工审核与追溯）' },
      commitRef: { type: 'string', description: 'delivered 时必填：本任务代码提交 SHA' }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute (args, exec) {
      const sessionId = exec.agent?.id
      if (sessionId === undefined) return '未关联到会话，无法定位工作项'
      const file = await loadBoards()
      let found: { board: Board; item: WorkItem } | null = null
      for (const board of Object.values(file.boards)) {
        const item = board.items.find(i => i.sessionId === sessionId && !i.archived)
        if (item !== undefined) {
          found = { board, item }
          break
        }
      }
      if (found === null) return '未找到与该会话关联的工作项'
      const located = found
      const lockKey = `item:${located.board.projectKey}:${located.item.id}`
      return withLock(lockKey, async () => {
      const { board: foundBoard, item } = located
      if (item.archived) return '工作项已经归档，拒绝更新执行状态'
      const summary = typeof args.summary === 'string' && args.summary.trim() !== ''
        ? args.summary.trim()
        : undefined
      if (args.outcome === 'blocked') {
        item.executionState = 'blocked'
        pushTimeline(item, { action: 'note', note: summary === undefined ? '执行阻塞' : `执行阻塞：${summary}` })
        touch(foundBoard, item)
        await saveBoards(file)
        return '已记录阻塞；请等待人工处理后再继续。'
      }
      if (args.outcome === 'delivery_ready') {
        item.executionState = 'awaiting-delivery'
        item.deliverySummary = summary
        pushTimeline(item, { action: 'note', note: summary === undefined ? '交付物已就绪，等待人工确认' : `交付物已就绪，等待人工确认：${summary}` })
        touch(foundBoard, item)
        await saveBoards(file)
        return '交付物已登记。请停止执行，等待人工确认交付；确认前严禁提交代码。'
      }
      if (args.outcome === 'delivered') {
        if (item.taskWorkspace !== undefined) return '当前任务由看板自动提交和集成，拒绝 Agent 自报 delivered。请等待人工确认交付。'
        const commitRef = typeof args.commitRef === 'string' ? args.commitRef.trim() : ''
        if (executionStateOf(item) !== 'committing') return '尚未收到人工确认交付，拒绝提交和归档。'
        if (commitRef === '') return 'delivered 必须提供已成功创建的代码提交 SHA。'
        item.commitRef = commitRef
        item.deliverySummary = summary ?? item.deliverySummary
        item.executionState = 'idle'
        const finalColumn = foundBoard.columns.at(-1)
        if (finalColumn !== undefined && item.status !== finalColumn.id) {
          pushTimeline(item, { action: 'moved', from: item.status, to: finalColumn.id, note: '代码已提交，进入完成环节' })
          item.status = finalColumn.id
        }
        pushTimeline(item, { action: 'note', note: `交付确认完成，代码提交：${commitRef}` })
        touch(foundBoard, item)
        try {
          await ctx.workspaceRegistry.archiveSession(SessionId(sessionId))
          item.archived = true
          pushTimeline(item, { action: 'note', note: '会话与卡片已归档，执行历史保留' })
          touch(foundBoard, item)
          await saveBoards(file)
        } catch (error) {
          item.executionState = 'failed'
          pushTimeline(item, { action: 'note', note: `代码已提交，但归档失败：${error instanceof Error ? error.message : String(error)}` })
          touch(foundBoard, item)
          await saveBoards(file)
          throw error
        }
        if (exec.agent !== undefined) retireDeliveredAgent(ctx, sessionId, exec.agent, lifecycle)
        return `交付完成：代码提交 ${commitRef}；会话和卡片已归档。`
      }

      const note = summary ?? `${columnLabel(foundBoard, item.status)}环节完成`
      if (executionModeOf(item) === 'review') {
        if (exec.agent === undefined) return '未关联到 Agent，无法确认当前环节是否已经执行完毕。'
        publishReviewAfterAgentIdle(exec.agent, sessionId, item.status, note, lifecycle)
        return '已记录当前环节产出。请结束本轮执行；会话完全停稳后看板才会进入待审核状态。'
      }
      if (exec.agent === undefined) return '未关联到 Agent，无法确认当前环节是否已经执行完毕。'
      advanceAutoStageAfterAgentIdle(exec.agent, sessionId, item.status, note, lifecycle)
      return '已记录当前环节产出。请立即结束本轮执行；会话完全停稳后才会流转，并由看板开启下一环节的新 turn。'
      })
    }
  })), 'taskboard: tool')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/taskboard',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const parts = url.pathname.split('/').filter(Boolean)
        // parts: ['taskboard', 'boards', key?, 'items', id?, 'run'?]
        const method = req.method ?? 'GET'
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJsonBody(req) : {}

        // ── 项目看板列表 ─────────────────────────────────────────
        if (parts[1] === 'boards' && parts.length === 2 && method === 'GET') {
          const file = await loadBoards()
          await recoverTaskWorkspaceRegistrations(ctx, file, error => { reportError(error) })
          // 同步 workspace 注册表：已注册项目自动获得看板
          const workspaces = ctx.workspaceRegistry.list().filter(w => !isTaskWorkspacePath(w.path)).map(w => ({
            id: w.id, path: w.path, title: w.title, sessionCount: w.sessionIds.length
          }))
          let createdBoard = false
          for (const w of workspaces) {
            if (file.boards[w.id] === undefined) createdBoard = true
            ensureBoard(file, w.id, w.path, w.title)
          }
          if (createdBoard) await saveBoards(file)
          const activeBoards = Object.fromEntries(Object.entries(file.boards).map(([boardKey, value]) => [
            boardKey,
            { ...value, items: value.items.filter(item => !item.archived) }
          ]))
          send(res, 200, { workspaces, boards: activeBoards })
          return
        }
        // ── 具体项目看板（parts[2] = key）────────────────────────
        const key = parts[2]
        if (key === undefined) {
          send(res, 400, { error: 'board key missing' })
          return
        }
        const file = await loadBoards()
        const board = file.boards[key]
        if (board === undefined) {
          send(res, 404, { error: '看板不存在' })
          return
        }

        // ── 当前工作区历史：按需分页，不进入 3 秒活动看板轮询 ──────
        if (parts.length === 4 && parts[3] === 'history' && method === 'GET') {
          const offsetValue = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
          const limitValue = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
          const offset = Number.isFinite(offsetValue) ? Math.max(0, offsetValue) : 0
          const limit = Number.isFinite(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 50
          const history = board.items
            .filter(item => item.archived)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          send(res, 200, { items: history.slice(offset, offset + limit), total: history.length })
          return
        }

        // ── 设置：自定义环节 / 类型 ────────────────────────────────
        if (parts.length === 4 && parts[3] === 'settings' && method === 'PUT') {
          const settings = validateSettings(board, body)
          board.columns = settings.columns
          board.itemTypes = settings.itemTypes
          board.updatedAt = new Date().toISOString()
          await saveBoards(file)
          send(res, 200, { board })
          return
        }

        // ── 工作项 CRUD ───────────────────────────────────────────
        if (parts[3] === 'items') {
          // GET 列表
          if (parts.length === 4 && method === 'GET') {
            send(res, 200, { items: board.items.filter(i => !i.archived) })
            return
          }
          // POST 新建
          if (parts.length === 4 && method === 'POST') {
            const item = createItemFromBody(board, body)
            pushTimeline(item, { action: 'created', to: item.status, note: `类型：${item.type}` })
            board.items.push(item)
            board.updatedAt = item.updatedAt
            await saveBoards(file)
            send(res, 200, { item })
            return
          }
          // PATCH 更新（含拖拽流转）
          if (parts.length === 5 && method === 'PATCH') {
            const item = findItem(board, parts[4] ?? '')
            const patch = validateItemPatch(board, item, body)
            const changesExecutionData = patch.title !== undefined || patch.desc !== undefined || patch.type !== undefined ||
              patch.priority !== undefined || patch.labels !== undefined || patch.parentId !== undefined ||
              patch.iteration !== undefined || patch.executionMode !== undefined || patch.status !== undefined
            if (changesExecutionData && executionActive(executionStateOf(item))) {
              send(res, 409, { error: '执行中的工作项不能编辑或手动改变环节' })
              return
            }
            if (patch.title !== undefined) item.title = patch.title
            if (patch.desc !== undefined) item.desc = patch.desc
            if (patch.type !== undefined) item.type = patch.type
            if (patch.priority !== undefined) item.priority = patch.priority
            if (patch.labels !== undefined) item.labels = patch.labels
            if (patch.parentId !== undefined) {
              if (patch.parentId === null) delete item.parentId
              else item.parentId = patch.parentId
            }
            if (patch.iteration !== undefined) {
              if (patch.iteration === null) delete item.iteration
              else item.iteration = patch.iteration
            }
            if (patch.executionMode !== undefined) item.executionMode = patch.executionMode
            if (patch.status !== undefined && patch.status !== item.status) {
              pushTimeline(item, { action: 'moved', from: item.status, to: patch.status })
              item.status = patch.status
            }
            if (patch.note !== undefined) pushTimeline(item, { action: 'note', note: patch.note })
            item.updatedAt = new Date().toISOString()
            board.updatedAt = item.updatedAt
            await saveBoards(file)
            send(res, 200, { item })
            return
          }
          // DELETE 随时删除：执行过则先停止 Agent、恢复任务前基线并归档会话。
          if (parts.length === 5 && method === 'DELETE') {
            const itemId = parts[4] ?? ''
            await withLock(`item:${board.projectKey}:${itemId}`, async () => {
            const item = findItem(board, itemId)
            const sid = item.sessionId
            let rolledBack = false
            let warning: string | undefined
            try {
              if (sid !== undefined) {
                const live = ctx.agents.get(SessionId(sid))
                if (live !== undefined) {
                  live.cancel({ kind: 'user' })
                  await live.whenIdle()
                  await ctx.sessions.flush(live.session)
                }
                const handle = agentHandles.get(sid)
                if (handle !== undefined) {
                  await handle.dispose()
                  agentHandles.delete(sid)
                }
                await ctx.workspaceRegistry.archiveSession(SessionId(sid))
              }
              if (item.taskWorkspace !== undefined) {
                await removeTaskWorkspaceRegistration(ctx, item.taskWorkspace, sid)
                await discardTaskWorkspace(item.taskWorkspace)
                rolledBack = true
              } else if (item.gitCheckpoint !== undefined) {
                await restoreGitCheckpoint(item.gitCheckpoint)
                rolledBack = true
              } else if (sid !== undefined) {
                warning = '旧任务没有执行前回退基线：Agent 和会话已关闭，卡片已删除，但旧文件改动未自动撤销'
              }
              item.executionState = 'idle'
              item.archived = true
              item.reviewSummary = undefined
              item.deliverySummary = undefined
              pushTimeline(item, {
                action: 'note',
                note: sid === undefined
                  ? '人工删除卡片'
                  : rolledBack
                    ? '人工删除任务；Agent 已停止，工作区已回退，会话已归档'
                    : '人工删除旧任务；Agent 已停止且会话已归档，但因缺少历史基线未回退文件'
              })
              touch(board, item)
              await saveBoards(file)
              send(res, 200, { item, rolledBack, warning })
            } catch (error) {
              item.executionState = 'failed'
              pushTimeline(item, { action: 'note', note: `删除任务前的安全关闭失败：${error instanceof Error ? error.message : String(error)}` })
              touch(board, item)
              await saveBoards(file)
              throw error
            }
            })
            return
          }
          // POST run：首次创建会话；阻塞/失败后的重试继续使用同一会话。
          if (parts.length === 6 && parts[5] === 'run' && method === 'POST') {
            const itemId = parts[4] ?? ''
            await withLock(`item:${board.projectKey}:${itemId}`, async () => {
              const item = findItem(board, itemId)
              const state = executionStateOf(item)
              const interruptedBootstrap = state === 'running' && item.sessionId === undefined
              if (executionActive(state) && !interruptedBootstrap) {
                send(res, 409, { error: '工作项已有进行中的执行，请打开关联会话查看状态' })
                return
              }
              const previous = structuredClone(item)
              const firstRun = item.sessionId === undefined
              const sessionId = item.sessionId ?? `taskboard-${board.projectKey}-${item.id}-${randomUUID()}`
              let handle: AgentHandle | undefined
              let workspaceCreatedNow: WorkItem['taskWorkspace']
              let registeredWorkspace: Workspace | undefined
              try {
                // 抢占状态发生在首个 await 前，并由 item lock 包围，杜绝双击创建两个 Agent。
                item.executionState = 'running'
                item.reviewSummary = undefined
                touch(board, item)
                await saveBoards(file)
                if (firstRun && item.taskWorkspace === undefined) {
                  const root = await resolveGitRoot(board.projectPath)
                  workspaceCreatedNow = await withLock(`repository:${root}`, async () => prepareTaskWorkspace(board.projectPath, item.id, WORKTREES_ROOT))
                  item.taskWorkspace = workspaceCreatedNow
                  item.integrationState = 'pending'
                  item.gitCheckpoint = undefined
                  touch(board, item)
                  await saveBoards(file)
                }
                const agentCwd = item.taskWorkspace?.path ?? board.projectPath
                const agent = firstRun
                  ? (handle = await createTaskAgent(ctx, sessionId, agentCwd)).agent
                  : await resolveTaskAgent(ctx, sessionId, item.agentPreset)
                if (handle !== undefined) {
                  agentHandles.set(sessionId, handle)
                  if (item.taskWorkspace === undefined) throw new Error('task workspace missing after Agent creation')
                  registeredWorkspace = await attachTaskSession(
                    ctx,
                    item.taskWorkspace,
                    sessionId,
                    `${board.projectTitle} · ${item.title}`
                  )
                }
                item.sessionId = sessionId
                item.agentPreset = agent.session.header.agentPreset
                if (firstRun) {
                  const next = nextColumn(board, item)
                  if (next !== undefined) {
                    pushTimeline(item, { action: 'moved', from: item.status, to: next.id, note: '创建独立 Git worktree 并开始执行' })
                    item.status = next.id
                  }
                }
                pushTimeline(item, { action: 'run', sessionId, note: firstRun ? `在独立分支 ${item.taskWorkspace?.branch ?? ''} 创建任务会话` : '在原会话继续执行' })
                touch(board, item)
                await saveBoards(file)
                followup(agent, executionPrompt(board, item))
                send(res, 200, { item })
              } catch (error) {
                const index = board.items.findIndex(candidate => candidate.id === item.id)
                if (index >= 0) board.items[index] = previous
                await saveBoards(file).catch(() => {})
                if (registeredWorkspace !== undefined) {
                  await removeTaskWorkspaceRegistration(ctx, item.taskWorkspace, sessionId).catch(() => {})
                }
                if (handle !== undefined) {
                  await handle.dispose().catch(() => {})
                  agentHandles.delete(sessionId)
                }
                if (workspaceCreatedNow !== undefined) await discardTaskWorkspace(workspaceCreatedNow).catch(() => {})
                throw error
              }
            })
            return
          }

          // POST force-close：中断 Agent，恢复任务开始前的 Git 基线，再归档会话与卡片。
          if (parts.length === 6 && parts[5] === 'force-close' && method === 'POST') {
            const itemId = parts[4] ?? ''
            await withLock(`item:${board.projectKey}:${itemId}`, async () => {
            const item = findItem(board, itemId)
            const sessionId = item.sessionId
            if (item.taskWorkspace === undefined && item.gitCheckpoint === undefined) {
              send(res, 409, { error: '工作项没有可回退的执行会话或 Git 基线' })
              return
            }
            const agent = sessionId === undefined ? undefined : ctx.agents.get(SessionId(sessionId))
            try {
              if (agent !== undefined) {
                agent.cancel({ kind: 'user' })
                await agent.whenIdle()
                await ctx.sessions.flush(agent.session)
              }
              if (sessionId !== undefined) {
                const handle = agentHandles.get(sessionId)
                if (handle !== undefined) {
                  await handle.dispose()
                  agentHandles.delete(sessionId)
                }
                await ctx.workspaceRegistry.archiveSession(SessionId(sessionId))
              }
              if (item.taskWorkspace !== undefined) {
                await removeTaskWorkspaceRegistration(ctx, item.taskWorkspace, sessionId)
                await discardTaskWorkspace(item.taskWorkspace)
              } else if (item.gitCheckpoint !== undefined) await restoreGitCheckpoint(item.gitCheckpoint)
              item.executionState = 'idle'
              item.archived = true
              item.reviewSummary = undefined
              item.deliverySummary = undefined
              pushTimeline(item, { action: 'note', note: '人工强制关闭任务；Agent 已停止，工作区已恢复到任务执行前基线，会话与卡片已归档' })
              touch(board, item)
              await saveBoards(file)
              send(res, 200, { item })
            } catch (error) {
              item.executionState = 'failed'
              pushTimeline(item, { action: 'note', note: `强制关闭未能完成安全回退：${error instanceof Error ? error.message : String(error)}` })
              touch(board, item)
              await saveBoards(file)
              throw error
            }
            })
            return
          }

          // 新任务由插件自动提交并集成；旧任务仍走原会话提交协议以保持兼容。
          if (parts.length === 6 && parts[5] === 'confirm-delivery' && method === 'POST') {
            const itemId = parts[4] ?? ''
            const candidate = findItem(board, itemId)
            if (candidate.taskWorkspace !== undefined) {
              await withLock(`item:${board.projectKey}:${itemId}`, async () => {
                const item = findItem(board, itemId)
                if (executionStateOf(item) !== 'awaiting-delivery') {
                  send(res, 409, { error: '交付物尚未就绪，不能确认交付' })
                  return
                }
                await finalizeIsolatedTask(ctx, file, board, item)
                send(res, 200, { item })
              })
              return
            }
          }

          // 重大任务审核与旧任务交付继续使用工作项唯一会话。
          if (parts.length === 6 && method === 'POST' && ['approve', 'reject', 'confirm-delivery'].includes(parts[5] ?? '')) {
            const action = parts[5]
            const itemId = parts[4] ?? ''
            await withLock(`item:${board.projectKey}:${itemId}`, async () => {
            const item = findItem(board, itemId)
            const sessionId = item.sessionId
            if (sessionId === undefined) {
              send(res, 409, { error: '工作项尚未创建执行会话' })
              return
            }
            const state = executionStateOf(item)
            if (action === 'approve' && state !== 'awaiting-review') {
              send(res, 409, { error: '当前没有待审核的环节产出' })
              return
            }
            if (action === 'reject' && state !== 'awaiting-review') {
              send(res, 409, { error: '当前没有可退回的环节产出' })
              return
            }
            if (action === 'confirm-delivery' && state !== 'awaiting-delivery') {
              send(res, 409, { error: '交付物尚未就绪，不能确认交付' })
              return
            }
            const agent = await resolveTaskAgent(ctx, sessionId, item.agentPreset)
            const previous = structuredClone(item)
            try {
              if (action === 'approve') {
                const next = nextColumn(board, item)
                const reviewed = item.reviewSummary
                item.reviewSummary = undefined
                if (next === undefined) {
                  item.executionState = 'awaiting-delivery'
                  item.deliverySummary = reviewed
                  pushTimeline(item, { action: 'note', note: '人工审核通过全部环节，等待确认交付' })
                } else {
                  pushTimeline(item, { action: 'moved', from: item.status, to: next.id, note: '人工审核通过' })
                  item.status = next.id
                  item.executionState = 'running'
                }
                touch(board, item)
                await saveBoards(file)
                if (next !== undefined) {
                  followup(agent, `人工已批准上一环节产出。现在进入「${next.label}」环节，请继续执行；完成后按既定规则调用 taskboard_progress。`)
                }
              } else if (action === 'reject') {
                item.executionState = 'running'
                pushTimeline(item, { action: 'note', note: '人工退回当前环节，要求修订后重新提交审核' })
                touch(board, item)
                await saveBoards(file)
                followup(agent, `人工未批准「${columnLabel(board, item.status)}」环节产出。请结合会话中的人工反馈修订本环节，不得进入下一环节；修订完成后再次调用 taskboard_progress(outcome="stage_complete")。`)
              } else {
                item.executionState = 'committing'
                pushTimeline(item, { action: 'note', note: '人工确认交付，授权最终检查与代码提交' })
                touch(board, item)
                await saveBoards(file)
                followup(agent, [
                  '人工已确认交付物。现在执行最终交付：',
                  '1. 重新检查交付物并运行项目要求的质量检查。',
                  '2. 检查 git diff，只提交本工作项产生的文件，严禁夹带用户或其他任务的改动。',
                  '3. 按项目规范创建一次有意义的 Git 提交。',
                  '4. 提交成功后调用 taskboard_progress(outcome="delivered", summary="交付与验证摘要", commitRef="提交 SHA")。',
                  '若检查失败、无法安全隔离改动或提交失败，调用 taskboard_progress(outcome="blocked", summary="原因")，不要虚报 delivered。'
                ].join('\n'))
              }
            } catch (error) {
              const index = board.items.findIndex(candidate => candidate.id === item.id)
              if (index >= 0) board.items[index] = previous
              await saveBoards(file).catch(() => {})
              throw error
            }
            send(res, 200, { item })
            })
            return
          }
        }

        send(res, 404, { error: 'not found' })
      } catch (err) {
        if (err instanceof HttpError) {
          send(res, err.status, { error: err.message })
          return
        }
        if (err instanceof TaskWorkspacePreconditionError) {
          send(res, 409, { error: err.message })
          return
        }
        if (err instanceof TaskboardDataError) {
          send(res, 503, { error: '看板数据无法安全读取；原文件和备份均已保留，请检查存储文件。' })
          return
        }
        const errorId = reportError(err)
        send(res, 500, { error: `任务看板内部错误（诊断编号：${errorId}）` })
      }
    },
  }), 'taskboard: route')
}
