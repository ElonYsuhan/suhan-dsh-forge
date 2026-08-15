/**
 * 需求看板插件，host 半：多项目看板 REST 服务。
 *
 * - 项目来源：DSH workspace 注册表（ctx.workspaceRegistry）+ 手动添加路径
 * - 数据落盘：datas/boards.json（version 2，按 projectKey 分看板）
 * - 任务执行：POST /boards/:key/items/:id/run 创建/复用 agent 会话并 followup，
 *   工作项记录 sessionId（任务 ↔ 聊天页档案）
 *
 * 路由（prefix /taskboard）：
 *   GET    /boards                         全部项目看板（同步 workspace 注册表）
 *   POST   /boards                         { path, title? } 手动注册项目
 *   GET    /boards/:key/items              工作项列表
 *   POST   /boards/:key/items              新建工作项
 *   PATCH  /boards/:key/items/:id          更新（含拖拽流转 → timeline.moved）
 *   DELETE /boards/:key/items/:id          随时删除（执行过则停止、回退、归档会话）
 *   POST   /boards/:key/items/:id/run      执行（建会话 + followup）
 *   POST   /boards/:key/items/:id/force-close 强制停止、回退并归档
 *   PUT    /boards/:key/settings           { columns?, itemTypes? } 自定义环节/类型
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { captureGitCheckpoint, restoreGitCheckpoint } from './gitCheckpoint.ts'
import { createBoard, executionModeOf, executionStateOf, type Board, type BoardsFile, type ColumnDef, type ExecutionState, type ItemTypeDef, type TimelineEntry, type WorkItem } from './shared/types.ts'

/**
 * Host services this plugin requires. Cordis only resolves `ctx` property
 * access for names declared here — without it the proxy throws
 * `cannot get property "webServer" without inject` at load time.
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'agents', 'agentDefaultModel', 'agentPresets', 'tools']

/** 数据文件：默认 <pkg>/datas/boards.json；DSH_TASKBOARD_DATA 覆盖（兼容 v1 语义） */
const DATA_FILE = process.env.DSH_TASKBOARD_DATA !== undefined
  ? resolve(process.env.DSH_TASKBOARD_DATA)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'datas', 'boards.json')

/** 活动执行句柄（createAgent 返回的 owner 能力）：归档时停止 agent 并归档会话。 */
const agentHandles = new Map<string, AgentHandle>()

/** 内存缓存：避免每次请求读盘 */
let cache: BoardsFile | null = null

async function loadBoards (): Promise<BoardsFile> {
  if (cache !== null) return cache
  try {
    cache = JSON.parse(await readFile(DATA_FILE, 'utf8')) as BoardsFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    cache = { version: 2, boards: {} }
    await saveBoards(cache)
  }
  return cache
}

/** 原子落盘（tmp + rename） */
async function saveBoards (file: BoardsFile): Promise<void> {
  cache = file
  await mkdir(dirname(DATA_FILE), { recursive: true })
  const tmp = `${DATA_FILE}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  await rename(tmp, DATA_FILE)
}

/** 读取请求体 JSON */
async function readBody (req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** JSON 响应 */
function send (res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
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

/** 类型守卫：普通对象 */
function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取单个工作项（不存在抛错） */
function findItem (board: Board, id: string): WorkItem {
  const item = board.items.find(i => i.id === id)
  if (item === undefined) throw new Error(`item not found: ${id}`)
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
    '',
    '必须遵守：',
    '- 先读取并遵守工作区内的工程指令。只处理本工作项，不覆盖或提交无关改动。',
    '- 每个环节都要在会话中给出可审核的结果，再调用 taskboard_progress(outcome="stage_complete", summary="本环节结果摘要")。',
    mode === 'review'
      ? '- 工具返回“结束本轮执行”后必须立即结束当前 turn；会话完全停稳后看板才会开放人工审核，不能自行进入下一环节。'
      : '- 每个 turn 最多完成一个环节。工具返回“结束本轮执行”后必须立即停止；会话停稳后看板才会流转，插件会另发下一环节的新 turn。',
    '- 遇到阻塞调用 taskboard_progress(outcome="blocked", summary="阻塞原因")。',
    '- 完成交付物和全部质量检查后调用 taskboard_progress(outcome="delivery_ready", summary="交付物与验证摘要")。',
    '- 未收到人工“确认交付”前严禁 git commit，也不得归档会话或工作项。',
    '- 收到确认交付指令后，只提交本工作项涉及的文件；提交成功后调用 taskboard_progress(outcome="delivered", summary="交付摘要", commitRef="提交 SHA")。'
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
  note: string
): void {
  const waitAndPublish = async (): Promise<void> => {
    await agent.whenIdle()
    const file = await loadBoards()
    for (const board of Object.values(file.boards)) {
      const item = board.items.find(candidate => candidate.sessionId === sessionId && !candidate.archived)
      if (item === undefined) continue
      if (executionStateOf(item) !== 'running' || item.status !== stageStatus) return
      item.executionState = 'awaiting-review'
      item.reviewSummary = note
      pushTimeline(item, { action: 'note', note: `环节产出待人工审核：${note}` })
      touch(board, item)
      await saveBoards(file)
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
  note: string
): void {
  const waitAndAdvance = async (): Promise<void> => {
    await agent.whenIdle()
    const file = await loadBoards()
    for (const board of Object.values(file.boards)) {
      const item = board.items.find(candidate => candidate.sessionId === sessionId && !candidate.archived)
      if (item === undefined) continue
      if (executionStateOf(item) !== 'running' || item.status !== stageStatus) return
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
      return
    }
  }
  waitAndAdvance().catch(() => {
    // Agent/插件卸载期间不流转，保持原环节，避免空转或重复推进。
  })
}

/** Agent 报告提交成功后，等待当前 turn 落盘并释放 live handle。 */
function retireDeliveredAgent (ctx: Context, sessionId: string, agent: Agent): void {
  (async () => {
    await agent.whenIdle()
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

/**
 * 需求看板插件 body，host 半。
 * @param ctx - host context（webServer / workspaceRegistry / sessions / agents / tools）。
 */
export function apply (ctx: Context): void {
  ctx.effect(() => async () => {
    const handles = [...agentHandles.values()]
    agentHandles.clear()
    await Promise.allSettled(handles.map(async handle => handle.dispose()))
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
      const { board: foundBoard, item } = found
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
        if (exec.agent !== undefined) retireDeliveredAgent(ctx, sessionId, exec.agent)
        return `交付完成：代码提交 ${commitRef}；会话和卡片已归档。`
      }

      const note = summary ?? `${columnLabel(foundBoard, item.status)}环节完成`
      if (executionModeOf(item) === 'review') {
        if (exec.agent === undefined) return '未关联到 Agent，无法确认当前环节是否已经执行完毕。'
        publishReviewAfterAgentIdle(exec.agent, sessionId, item.status, note)
        return '已记录当前环节产出。请结束本轮执行；会话完全停稳后看板才会进入待审核状态。'
      }
      if (exec.agent === undefined) return '未关联到 Agent，无法确认当前环节是否已经执行完毕。'
      advanceAutoStageAfterAgentIdle(exec.agent, sessionId, item.status, note)
      return '已记录当前环节产出。请立即结束本轮执行；会话完全停稳后才会流转，并由看板开启下一环节的新 turn。'
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
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {}

        // ── 项目看板列表 / 手动注册 ───────────────────────────────
        if (parts[1] === 'boards' && parts.length === 2 && method === 'GET') {
          const file = await loadBoards()
          // 同步 workspace 注册表：已注册项目自动获得看板
          const workspaces = ctx.workspaceRegistry.list().map(w => ({
            id: w.id, path: w.path, title: w.title, sessionCount: w.sessionIds.length
          }))
          for (const w of workspaces) ensureBoard(file, w.id, w.path, w.title)
          if (workspaces.length > 0) await saveBoards(file)
          send(res, 200, { workspaces, boards: file.boards })
          return
        }
        if (parts[1] === 'boards' && parts.length === 2 && method === 'POST') {
          if (!isObject(body) || typeof body.path !== 'string') {
            send(res, 400, { error: 'body.path (string) required' })
            return
          }
          const ws = await ctx.workspaceRegistry.create(body.path, typeof body.title === 'string' ? body.title : undefined)
          const file = await loadBoards()
          const board = ensureBoard(file, ws.id, ws.path, ws.title)
          await saveBoards(file)
          send(res, 200, { workspace: { id: ws.id, path: ws.path, title: ws.title }, board })
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
          send(res, 404, { error: `board not found: ${key}` })
          return
        }

        // ── 设置：自定义环节 / 类型 ────────────────────────────────
        if (parts.length === 4 && parts[3] === 'settings' && method === 'PUT') {
          if (isObject(body)) {
            if (Array.isArray(body.columns)) {
              board.columns = (body.columns as ColumnDef[]).filter(c => isObject(c) && typeof c.id === 'string' && typeof c.label === 'string')
            }
            if (Array.isArray(body.itemTypes)) {
              board.itemTypes = (body.itemTypes as ItemTypeDef[]).filter(t => isObject(t) && typeof t.key === 'string' && typeof t.label === 'string')
            }
          }
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
            if (!isObject(body) || typeof body.title !== 'string' || body.title.trim() === '') {
              send(res, 400, { error: 'body.title (non-empty string) required' })
              return
            }
            const now = new Date().toISOString()
            const item: WorkItem = {
              id: randomUUID(),
              type: typeof body.type === 'string' ? body.type : 'task',
              title: body.title.trim(),
              desc: typeof body.desc === 'string' ? body.desc : '',
              priority: typeof body.priority === 'string' ? body.priority as WorkItem['priority'] : 'medium',
              labels: Array.isArray(body.labels) ? (body.labels as string[]).filter(l => typeof l === 'string') : [],
              status: typeof body.status === 'string' ? body.status : board.columns[0]?.id ?? 'todo',
              parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
              iteration: typeof body.iteration === 'string' ? body.iteration : undefined,
              executionMode: body.executionMode === 'review' ? 'review' : 'auto',
              executionState: 'idle',
              timeline: [],
              createdAt: now,
              updatedAt: now,
              archived: false
            }
            pushTimeline(item, { action: 'created', to: item.status, note: `类型：${item.type}` })
            board.items.push(item)
            board.updatedAt = now
            await saveBoards(file)
            send(res, 200, { item })
            return
          }
          // PATCH 更新（含拖拽流转）
          if (parts.length === 5 && method === 'PATCH') {
            const item = findItem(board, parts[4] ?? '')
            if (!isObject(body)) {
              send(res, 400, { error: 'body object required' })
              return
            }
            if (typeof body.title === 'string') item.title = body.title.trim()
            if (typeof body.desc === 'string') item.desc = body.desc
            if (typeof body.type === 'string') item.type = body.type
            if (typeof body.priority === 'string') item.priority = body.priority as WorkItem['priority']
            if (Array.isArray(body.labels)) item.labels = (body.labels as string[]).filter(l => typeof l === 'string')
            if (typeof body.parentId === 'string') item.parentId = body.parentId
            if (typeof body.iteration === 'string') item.iteration = body.iteration
            if (body.executionMode === 'auto' || body.executionMode === 'review') item.executionMode = body.executionMode
            if (typeof body.status === 'string' && body.status !== item.status) {
              if (executionActive(executionStateOf(item))) {
                send(res, 409, { error: '执行中的工作项只能通过审核流程改变环节' })
                return
              }
              pushTimeline(item, { action: 'moved', from: item.status, to: body.status })
              item.status = body.status
            }
            if (isObject(body.meta) && typeof body.meta.note === 'string') {
              pushTimeline(item, { action: 'note', note: body.meta.note })
            }
            item.updatedAt = new Date().toISOString()
            board.updatedAt = item.updatedAt
            await saveBoards(file)
            send(res, 200, { item })
            return
          }
          // DELETE 随时删除：执行过则先停止 Agent、恢复任务前基线并归档会话。
          if (parts.length === 5 && method === 'DELETE') {
            const item = findItem(board, parts[4] ?? '')
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
                if (item.gitCheckpoint !== undefined) {
                  await restoreGitCheckpoint(item.gitCheckpoint)
                  rolledBack = true
                } else {
                  warning = '旧任务没有执行前回退基线：Agent 和会话已关闭，卡片已删除，但旧文件改动未自动撤销'
                }
                const handle = agentHandles.get(sid)
                if (handle !== undefined) {
                  await handle.dispose()
                  agentHandles.delete(sid)
                }
                await ctx.workspaceRegistry.archiveSession(SessionId(sid))
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
            return
          }
          // POST run：首次创建会话；阻塞/失败后的重试继续使用同一会话。
          if (parts.length === 6 && parts[5] === 'run' && method === 'POST') {
            const item = findItem(board, parts[4] ?? '')
            const state = executionStateOf(item)
            if (executionActive(state)) {
              send(res, 409, { error: '工作项已有进行中的执行，请打开关联会话查看状态' })
              return
            }
            const previous = structuredClone(item)
            const firstRun = item.sessionId === undefined
            const sessionId = item.sessionId ?? `taskboard-${board.projectKey}-${item.id}-${randomUUID()}`
            let handle: AgentHandle | undefined
            let workspace: Awaited<ReturnType<typeof ctx.workspaceRegistry.resolveByPath>>
            try {
              if (firstRun) item.gitCheckpoint = await captureGitCheckpoint(board.projectPath)
              const agent = firstRun
                ? (handle = await createTaskAgent(ctx, sessionId, board.projectPath)).agent
                : await resolveTaskAgent(ctx, sessionId, item.agentPreset)
              if (handle !== undefined) {
                agentHandles.set(sessionId, handle)
                workspace = await ctx.workspaceRegistry.resolveByPath(board.projectPath)
                if (workspace === undefined) throw new Error(`workspace not found for ${board.projectPath}`)
                await workspace.attachSession(SessionId(sessionId))
              }
              item.sessionId = sessionId
              item.agentPreset = agent.session.header.agentPreset
              item.executionState = 'running'
              item.reviewSummary = undefined
              if (firstRun) {
                const next = nextColumn(board, item)
                if (next !== undefined) {
                  pushTimeline(item, { action: 'moved', from: item.status, to: next.id, note: '开始执行' })
                  item.status = next.id
                }
              }
              pushTimeline(item, { action: 'run', sessionId, note: firstRun ? '创建任务会话并开始执行' : '在原会话继续执行' })
              touch(board, item)
              await saveBoards(file)
              followup(agent, executionPrompt(board, item))
            } catch (error) {
              const index = board.items.findIndex(candidate => candidate.id === item.id)
              if (index >= 0) board.items[index] = previous
              await saveBoards(file).catch(() => {})
              if (workspace !== undefined) await workspace.detachSession(SessionId(sessionId)).catch(() => {})
              if (handle !== undefined) {
                await handle.dispose().catch(() => {})
                agentHandles.delete(sessionId)
              }
              throw error
            }
            send(res, 200, { item })
            return
          }

          // POST force-close：中断 Agent，恢复任务开始前的 Git 基线，再归档会话与卡片。
          if (parts.length === 6 && parts[5] === 'force-close' && method === 'POST') {
            const item = findItem(board, parts[4] ?? '')
            const sessionId = item.sessionId
            if (sessionId === undefined || item.gitCheckpoint === undefined) {
              send(res, 409, { error: '工作项没有可回退的执行会话或 Git 基线' })
              return
            }
            const agent = ctx.agents.get(SessionId(sessionId))
            try {
              if (agent !== undefined) {
                agent.cancel({ kind: 'user' })
                await agent.whenIdle()
                await ctx.sessions.flush(agent.session)
              }
              await restoreGitCheckpoint(item.gitCheckpoint)
              const handle = agentHandles.get(sessionId)
              if (handle !== undefined) {
                await handle.dispose()
                agentHandles.delete(sessionId)
              }
              await ctx.workspaceRegistry.archiveSession(SessionId(sessionId))
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
            return
          }

          // POST approve/reject/confirm-delivery：全部继续使用工作项唯一会话。
          if (parts.length === 6 && method === 'POST' && ['approve', 'reject', 'confirm-delivery'].includes(parts[5] ?? '')) {
            const action = parts[5]
            const item = findItem(board, parts[4] ?? '')
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
            return
          }
        }

        send(res, 404, { error: 'not found' })
      } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'taskboard: route')
}
