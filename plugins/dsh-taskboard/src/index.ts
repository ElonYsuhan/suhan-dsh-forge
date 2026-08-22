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
import { createBoard, creationStateOf, executionModeOf, executionStateOf, isAiFlowItem, type AiAnalysis, type Board, type BoardsFile, type ColumnDef, type ExecutionState, type TimelineEntry, type WorkItem } from './shared/types.ts'
import { readStoredBoards, taskboardDataPaths, TaskboardDataError } from './storage.ts'
import { commitTaskWorkspace, continueTaskIntegration, discardTaskWorkspace, integrateTaskWorkspace, prepareTaskWorkspace, resetTaskWorkspaceWorkingTree, resolveGitRoot, TaskWorkspacePreconditionError, type IntegrationResult } from './taskWorkspace.ts'
import { renderFilePreview, renderItemPreview } from './preview.ts'
import { resolvePreviewBase } from './previewServer.ts'
import { createItemFromBody, normalizePreviewUrls, validateAiAnalysisBody, validateItemPatch, validateSettings } from './validation.ts'

/**
 * Host services this plugin requires. Cordis only resolves `ctx` property
 * access for names declared here — without it the proxy throws
 * `cannot get property "webServer" without inject` at load time.
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'agents', 'agentDefaultModel', 'agentPresets', 'tools']

/** 数据文件：默认 $DSH_HOME/storages/dsh-taskboard/boards.json；环境变量可覆盖。 */
const DATA_PATHS = taskboardDataPaths(import.meta.url)
const DATA_FILE = DATA_PATHS.dataFile
const LEGACY_WORKTREES_ROOT = resolve(dirname(DATA_FILE), 'worktrees')

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
  const resolvedPath = resolve(path)
  const legacyChild = relative(LEGACY_WORKTREES_ROOT, resolvedPath)
  const legacy = legacyChild !== '' && legacyChild !== '..' && !legacyChild.startsWith(`..${sep}`) && !isAbsolute(legacyChild)
  return legacy || resolvedPath.includes(`${sep}.dsh-taskboard-worktrees${sep}`)
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

/** 是否已有一条不能并发替换的执行。 */
function executionActive (state: ExecutionState): boolean {
  return state === 'running' || state === 'awaiting-review' || state === 'awaiting-delivery' || state === 'committing'
}

/** 构造首次执行指令。 */
function executionPrompt (board: Board, item: WorkItem): string {
  const mode = executionModeOf(item)
  const phase = columnLabel(board, item.status)
  const workColumn = board.columns.at(-2) ?? board.columns.at(-1)
  const finalColumn = board.columns.at(-1)
  const frozen = item.frozenPlan
  const frozenLines = frozen === undefined
    ? [
        `【标题】${item.title}`,
        item.desc === '' ? '' : `【描述】${item.desc}`,
        item.iteration === undefined ? '' : `【迭代】${item.iteration}`
      ]
    : [
        `【标题】${item.title}`,
        '',
        '【执行依据】以下是已确认并冻结的实施方案，是本次执行的唯一依据：',
        frozen,
        '',
        '必须严格遵守冻结方案：',
        '- 按【实施方案】逐步执行；不得按原始需求自行发挥，不得扩大或缩小范围，不得修改已冻结的方案。',
        '- 【待确认项】中影响执行的问题必须先解决：若未获得明确结论，调用 taskboard_progress(outcome="blocked", summary="待确认项：…") 等待人工确认，不得擅自假设。',
        '- 需求理解与验收标准以冻结方案为准；发现方案与仓库实际不一致时先调用 taskboard_progress(outcome="blocked", summary="方案与仓库现状不一致：…") 说明，等待人工指示。'
      ]
  return [
    `请执行以下工作项。项目：${board.projectTitle}；实际工作目录：${item.taskWorkspace?.path ?? board.projectPath}。`,
    ...frozenLines,
    `【执行策略】${mode === 'review' ? '重大任务：每个环节必须人工审核' : '小任务：单轮端到端完成，交付就绪后卡片进入验收列'}`,
    `【当前环节】${phase}`,
    '【Git 隔离】当前会话位于本任务独占 worktree；其他任务会在各自目录并行执行。',
    '',
    '必须遵守：',
    '- 先读取并遵守工作区内的工程指令。只处理本工作项，不覆盖或提交无关改动。',
    '- 所有命令和文件修改必须留在上述实际工作目录；严禁 cd 到原项目主工作区或其他任务目录。',
    mode === 'review'
      ? '- 每个环节都要在会话中给出可审核的结果，再调用 taskboard_progress(outcome="stage_complete", summary="本环节结果摘要")。'
      : `- 单轮端到端执行：在「${workColumn?.label ?? ''}」列内依次完成分析、排期、开发、测试等全部环节，每完成一个环节调用一次 taskboard_progress(outcome="stage_complete", summary="本环节结果摘要")，环节记录会写入卡片时间线；每个环节只汇报一次，不要重复调用，也不要跳过环节。全部环节与质量检查完成后调用 taskboard_progress(outcome="delivery_ready", summary="交付物与验证摘要")，看板会把卡片推进到「${finalColumn?.label ?? ''}」列等待人工确认交付。`,
    mode === 'review'
      ? '- 工具返回“结束本轮执行”后必须立即结束当前 turn；会话完全停稳后看板才会开放人工审核，不能自行进入下一环节。'
      : '- 只执行一个端到端 turn。避免重复扫描仓库、重复跑全量门禁或启动常驻服务；验证强度与变更范围匹配：文档/注释改动不跑测试与门禁，代码改动只跑受影响项目的 typecheck 与测试，仅跨模块行为变更才在交付前跑一次完整 pnpm check。',
    '- 交付必须是可实际使用的完整功能：验证主要用户路径、错误路径和资源释放；不得只生成代码或只验证 mock 调用。',
    '- 控制资源：不要读取构建产物/依赖目录，不输出无界日志，不启动无上限并发，不保留 watcher/dev server；发现疑似内存增长、死循环或性能回退必须先修复再交付。',
    '- 依赖安装只做一次（pnpm install --frozen-lockfile），之后复用；不要重复安装或重新下载依赖。',
    '- 遇到阻塞调用 taskboard_progress(outcome="blocked", summary="阻塞原因")。',
    '- 全程严禁 git commit、切换分支或操作项目主工作区；看板会在人工确认交付后自动生成任务提交并串行集成。',
    '- 完成全部环节和质量检查后调用 taskboard_progress(outcome="delivery_ready", summary="交付物与验证摘要")，然后等待人工确认。',
    '- 若改动涉及可预览的可见页面（web 界面效果），delivery_ready 时附带 previewUrls：报告改动页面的预览地址（相对路径如 /taskboard/boards，或完整 http(s) URL，最多 10 个），方便人工验收直接打开页面查看效果；不要编造不存在的地址，纯后端/工具改动无需提供。'
  ].filter(line => line !== '').join('\n')
}

/** 把结构化方案渲染成固定模板 markdown（冻结方案，执行唯一依据）。 */
function renderPlanMarkdown (title: string, analysis: AiAnalysis): string {
  const bulletList = (items: string[]): string =>
    items.length === 0 ? '- 无' : items.map(item => `- ${item}`).join('\n')
  return [
    `# ${title}`,
    '',
    '> 本方案经人工确认，执行时以本方案为唯一依据。',
    '',
    '## 需求理解',
    analysis.requirementUnderstanding,
    '',
    '## 项目现状分析',
    analysis.projectAnalysis,
    '',
    '## 实施方案',
    analysis.implementationPlan.length === 0
      ? '1. 无'
      : analysis.implementationPlan.map((step, index) => `${index + 1}. ${step}`).join('\n'),
    '',
    '## 影响范围',
    bulletList(analysis.affectedModules),
    '',
    '## 待确认项',
    bulletList(analysis.pendingQuestions),
    '',
    '## 验收标准',
    bulletList(analysis.acceptanceCriteria)
  ].join('\n')
}

/** 构造只读方案生成指令（结合当前真实项目产出结构化方案）。 */
function analysisPrompt (board: Board, item: WorkItem, supplement?: string): string {
  const current = item.aiAnalysis
  const currentText = current === undefined
    ? '无'
    : [
        `建议标题：${current.suggestedTitle ?? ''}`,
        `需求理解：${current.requirementUnderstanding}`,
        `项目现状分析：${current.projectAnalysis}`,
        `实施方案：\n${current.implementationPlan.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
        `影响范围：\n${current.affectedModules.map(module => `- ${module}`).join('\n')}`,
        `待确认项：\n${current.pendingQuestions.map(question => `- ${question}`).join('\n')}`,
        `验收标准：\n${current.acceptanceCriteria.map(criterion => `- ${criterion}`).join('\n')}`
      ].join('\n')
  return [
    '请对以下「想法」做只读的工程分析，产出结构化实施方案。',
    '',
    `项目：${board.projectTitle}`,
    `实际工作目录：${item.taskWorkspace?.path ?? board.projectPath}（任务独占快照 worktree，只读分析；非 Git 项目为项目主目录）`,
    '',
    '原始需求：',
    item.originalRequirement ?? item.desc,
    supplement === undefined || supplement.trim() === '' ? '' : `\n补充需求（重新分析）：\n${supplement}`,
    '',
    '现有方案（重新分析时给出，供修订）：',
    currentText,
    '',
    '分析任务（严格只读：禁止创建/修改/删除任何文件，禁止 git commit/checkout/branch，',
    '禁止运行有副作用的命令，只允许只读查看命令）：',
    '1. 阅读工作区工程指令（CLAUDE.md / AGENTS.md / README 等）与当前技术栈（package.json / lockfile），理解约束。',
    '2. 查看目录结构与相关代码，确认需求落点、可复用能力（已有模块/工具/脚本）、影响面。',
    '3. 评估风险与待确认项（需求歧义、外部决策依赖、阻塞前提）。',
    '',
    '产出：调用 taskboard_analysis 工具一次性提交结构化方案：',
    '- suggestedTitle：建议的卡片标题',
    '- requirementUnderstanding：需求理解（含隐含诉求与边界）',
    '- projectAnalysis：项目现状分析（工程指令要点 / 技术栈 / 相关代码 / 可复用能力 / 落点）',
    '- implementationPlan：实施方案步骤（每步具体到文件或模块，可直接执行）',
    '- affectedModules：影响范围（改动 / 新增 / 风险模块）',
    '- pendingQuestions：待确认项（影响执行决策的开放问题）',
    '- acceptanceCriteria：验收标准（可验证）',
    '',
    '严格约束：',
    '- 必须调用 taskboard_analysis 提交方案；调用成功后立即结束当前 turn。',
    '- 一次分析只调用一次 taskboard_analysis；不要调用 taskboard_progress，不要执行任何实现工作。',
    '- 禁止虚构不存在的文件、组件、接口、目录；所有结论必须来自真实检索到的代码。',
    '- 优先复用已有能力；不得为"架构完整"随意扩大需求范围。',
    '- 无法从代码或需求确定的重要内容必须列入待确认项，禁止擅自假设核心业务逻辑。'
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
 * 兼容旧 Agent 的 stage_complete：等当前 turn 停稳后直接开放交付，不再启动下一环节。
 * 同一 turn 的重复调用只有第一个能通过状态校验。
 */
function publishAutoDeliveryAfterAgentIdle (
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
        item.executionState = 'awaiting-delivery'
        item.deliverySummary = note
        pushTimeline(item, { action: 'note', note: `小任务单轮执行完成，等待人工确认交付：${note}` })
        touch(board, item)
        await saveBoards(file)
      })
      return
    }
  }
  waitAndPublish().catch(() => {
    // Agent/插件卸载期间不开放交付，保持 running，避免错误确认。
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

/** 完成任务后只释放 live Agent；会话、worktree 与临时 Workspace 作为可打开的历史档案保留。 */
async function preserveTaskSession (ctx: Context, item: WorkItem): Promise<string | undefined> {
  if (item.sessionId === undefined) return undefined
  const errors: string[] = []
  try {
    const live = ctx.agents.get(SessionId(item.sessionId))
    if (live !== undefined) {
      await live.whenIdle()
      await ctx.sessions.flush(live.session)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const handle = agentHandles.get(item.sessionId)
    if (handle !== undefined) {
      await handle.dispose()
      agentHandles.delete(item.sessionId)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return errors.length === 0 ? undefined : errors.join('；')
}

/** 清理已完成任务的临时 Workspace/worktree，但保留未归档 Session 日志供历史入口打开。 */
async function cleanupCompletedWorkspace (ctx: Context, item: WorkItem): Promise<void> {
  const workspace = item.taskWorkspace
  if (workspace === undefined) return
  await removeTaskWorkspaceRegistration(ctx, workspace, item.sessionId)
  await discardTaskWorkspace(workspace)
  item.taskWorkspace = undefined
}

/** 冲突解决工具在 Agent turn 内调用；等 turn 停稳后再释放其 cwd 和临时 Workspace。 */
function cleanupResolvedWorkspaceAfterAgentIdle (
  ctx: Context,
  agent: Agent,
  boardKey: string,
  itemId: string,
  lifecycle: LifecycleState
): void {
  const cleanup = async (): Promise<void> => {
    await agent.whenIdle()
    if (!lifecycle.active) return
    const file = await loadBoards()
    const board = file.boards[boardKey]
    const item = board?.items.find(candidate => candidate.id === itemId)
    if (board === undefined || item === undefined) return
    await withLock(`item:${boardKey}:${itemId}`, async () => {
      await cleanupCompletedWorkspace(ctx, item)
      pushTimeline(item, { action: 'note', note: '冲突解决会话已停稳；临时 Workspace/worktree 自动清理，聊天记录保留' })
      touch(board, item)
      await saveBoards(file)
    })
  }
  cleanup().catch(() => {
    // 保留 taskWorkspace 元数据供历史面板手动重试清理，不伪装成功。
  })
}

async function requestConflictResolution (
  ctx: Context,
  file: BoardsFile,
  board: Board,
  item: WorkItem,
  result: Extract<IntegrationResult, { kind: 'conflicted' }>
): Promise<void> {
  item.commitRef = result.sourceCommit
  item.integrationState = 'conflicted'
  item.executionState = result.rebaseInProgress ? 'running' : 'blocked'
  pushTimeline(item, { action: 'note', note: `变基集成受阻，保留在原任务处理：${result.reason}` })
  touch(board, item)
  await saveBoards(file)
  if (!result.rebaseInProgress || item.sessionId === undefined) return
  const agent = await resolveTaskAgent(ctx, item.sessionId, item.agentPreset)
  followup(agent, [
    '自动变基集成遇到代码冲突。请在当前任务 worktree 中根据整个仓库的功能、测试和工程约束自主解决所有冲突。',
    '不要创建新任务，不要切换分支，不要运行 git commit/rebase/merge；可以编辑冲突文件并执行验证。',
    '确认语义正确且 git diff --check、相关测试通过后，调用 taskboard_progress(outcome="integration_resolved", summary="冲突取舍与验证摘要")。'
  ].join('\n'))
}

/** 自动提交任务 worktree，并在仓库级短锁内集成到目标分支。 */
async function finalizeIsolatedTask (ctx: Context, file: BoardsFile, board: Board, item: WorkItem): Promise<void> {
  const workspace = item.taskWorkspace
  if (workspace === undefined) throw new Error('任务缺少隔离 worktree，不能使用自动集成流程')
  const pendingCommit = item.integrationState === 'conflicted' ? item.commitRef : undefined

  item.executionState = 'committing'
  item.integrationState = 'integrating'
  pushTimeline(item, { action: 'note', note: '人工确认交付；看板开始自动提交并串行集成' })
  touch(board, item)
  await saveBoards(file)

  let sourceCommit: string
  try {
    sourceCommit = pendingCommit !== undefined
      ? pendingCommit
      : await commitTaskWorkspace(workspace, item.id, item.title)
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
      reason: `自动集成过程异常终止：${error instanceof Error ? error.message : String(error)}`,
      rebaseInProgress: false
    }))
  if (result.kind === 'conflicted') {
    await requestConflictResolution(ctx, file, board, item, result)
    return
  }

  item.commitRef = result.commit
  item.integrationState = 'merged'
  item.executionState = 'idle'
  if (isAiFlowItem(item)) item.creationState = 'completed'
  const finalColumn = board.columns.at(-1)
  if (finalColumn !== undefined && item.status !== finalColumn.id) {
    pushTimeline(item, { action: 'moved', from: item.status, to: finalColumn.id, note: '任务提交已自动集成' })
    item.status = finalColumn.id
  }
  item.archived = true
  pushTimeline(item, { action: 'note', note: `自动提交并集成完成：${result.commit}；任务已归档到历史任务` })
  const sessionWarning = await preserveTaskSession(ctx, item)
  await cleanupCompletedWorkspace(ctx, item)
  if (sessionWarning !== undefined) pushTimeline(item, { action: 'note', note: `代码已集成，但历史会话落盘失败：${sessionWarning}` })
  touch(board, item)
  await saveBoards(file)
}

interface StartExecutionOptions {
  /** 执行开始后推进到下一列；run 首次执行与 confirm-plan 为 true。 */
  advanceStatus: boolean
  /** 推进流转的时间线条目备注。 */
  statusMoveNote?: string
  /** run 时间线条目备注。 */
  timelineNote?: string
}

/**
 * 启动任务执行：创建/复用隔离 worktree 与 Agent 会话，followup 执行指令。
 * 调用方必须持有 item lock，并在外部完成归档/执行中/AI 流程闸门等守卫检查。
 */
async function startExecution (
  ctx: Context,
  file: BoardsFile,
  board: Board,
  item: WorkItem,
  options: StartExecutionOptions
): Promise<void> {
  const previous = structuredClone(item)
  let firstRun = item.sessionId === undefined
  let sessionId = item.sessionId ?? `taskboard-${board.projectKey}-${item.id}-${randomUUID()}`
  let handle: AgentHandle | undefined
  let workspaceCreatedNow: WorkItem['taskWorkspace']
  let registeredWorkspace: Workspace | undefined
  try {
    // 抢占状态发生在首个 await 前，并由 item lock 包围，杜绝双击创建两个 Agent。
    item.executionState = 'running'
    item.reviewSummary = undefined
    touch(board, item)
    await saveBoards(file)
    if ((firstRun || isAiFlowItem(item)) && item.taskWorkspace === undefined) {
      const root = await resolveGitRoot(board.projectPath)
      workspaceCreatedNow = await withLock(`repository:${root}`, async () => prepareTaskWorkspace(board.projectPath, item.id))
      item.taskWorkspace = workspaceCreatedNow
      item.integrationState = 'pending'
      item.gitCheckpoint = undefined
      touch(board, item)
      await saveBoards(file)
    }
    const agentCwd = item.taskWorkspace?.path ?? board.projectPath
    // 旧分析会话（非 Git 回退创建）的 cwd 是不可变 session header；补齐 worktree 后
    // 必须换新执行会话绑定 worktree，否则执行会落在项目主工作区。
    const needsFreshSession = workspaceCreatedNow !== undefined && !firstRun
    if (needsFreshSession) sessionId = `taskboard-${board.projectKey}-${item.id}-${randomUUID()}`
    let agent: Agent
    if (firstRun || needsFreshSession) {
      handle = await createTaskAgent(ctx, sessionId, agentCwd)
      agent = handle.agent
    } else {
      agent = await resolveTaskAgent(ctx, sessionId, item.agentPreset)
    }
    if (handle !== undefined) {
      agentHandles.set(sessionId, handle)
      if (item.taskWorkspace === undefined) throw new Error('task workspace missing after Agent creation')
      registeredWorkspace = await attachTaskSession(
        ctx,
        item.taskWorkspace,
        sessionId,
        `${board.projectTitle} · ${item.title}`
      )
    } else if (item.taskWorkspace !== undefined && item.taskWorkspace.workspaceId === undefined) {
      // 工作区注册在插件重启后可能丢失，恢复执行时重新挂载。
      await attachTaskSession(ctx, item.taskWorkspace, sessionId, `${board.projectTitle} · ${item.title}`)
    }
    item.sessionId = sessionId
    item.agentPreset = agent.session.header.agentPreset
    if (isAiFlowItem(item) && item.creationState === 'confirmed') item.creationState = 'executing'
    if (options.advanceStatus) {
      const next = nextColumn(board, item)
      if (next !== undefined) {
        pushTimeline(item, { action: 'moved', from: item.status, to: next.id, note: options.statusMoveNote ?? '创建独立 Git worktree 并开始执行' })
        item.status = next.id
      }
    }
    pushTimeline(item, { action: 'run', sessionId, note: options.timelineNote ?? (firstRun ? `在独立分支 ${item.taskWorkspace?.branch ?? ''} 创建任务会话` : '在原会话继续执行') })
    touch(board, item)
    await saveBoards(file)
    followup(agent, executionPrompt(board, item))
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

  // 方案生成结果由生成会话通过该工具提交；这是创建流程在确认前的唯一产出口。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_analysis',
    description: '向需求看板提交方案生成产出的结构化需求方案。分析过程严格只读；调用成功后必须立即结束当前 turn，等待人工确认方案。',
    parameters: {
      suggestedTitle: { type: 'string', description: '建议的卡片标题' },
      requirementUnderstanding: { type: 'string', required: true, description: '需求理解：重新描述用户真正想实现什么（含隐含诉求与边界）' },
      projectAnalysis: { type: 'string', required: true, description: '项目现状分析：工程指令要点/技术栈/相关代码/可复用能力/需求落点' },
      implementationPlan: { type: 'array', items: { type: 'string' }, required: true, description: '实施方案：具体到文件或模块、可直接执行的步骤列表' },
      affectedModules: { type: 'array', items: { type: 'string' }, required: true, description: '影响范围：受影响的页面/组件/接口/状态/路由等' },
      pendingQuestions: { type: 'array', items: { type: 'string' }, required: true, description: '待确认项：无法从代码或需求确定、影响执行决策的开放问题' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' }, required: true, description: '验收标准：明确、可检查的验收条件' }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute (args, exec) {
      const sessionId = exec.agent?.id
      if (sessionId === undefined) return '未关联到会话，无法定位工作项'
      const file = await loadBoards()
      let located: { board: Board; item: WorkItem } | null = null
      for (const board of Object.values(file.boards)) {
        const item = board.items.find(candidate => candidate.sessionId === sessionId && !candidate.archived)
        if (item !== undefined) {
          located = { board, item }
          break
        }
      }
      if (located === null) return '未找到与该会话关联的工作项'
      const { board: foundBoard, item } = located
      const lockKey = `item:${foundBoard.projectKey}:${item.id}`
      return withLock(lockKey, async () => {
        if (item.archived) return '工作项已经归档，拒绝更新分析结果'
        if (!isAiFlowItem(item)) return '该工作项不是 AI 创建流程的工作项'
        if (creationStateOf(item) !== 'analyzing') {
          return '当前不处于分析中（方案已生成或分析未开始）。若方案已提交，请立即结束当前 turn。'
        }
        // 清洗模型产出（不抛错）：字段截断、丢弃空项，避免坏数据写盘。
        const cleanText = (value: unknown, max: number): string =>
          typeof value === 'string' ? value.trim().slice(0, max) : ''
        const cleanList = (value: unknown, maxItems: number, maxLen: number): string[] =>
          Array.isArray(value)
            ? value.map(entry => typeof entry === 'string' ? entry.trim().slice(0, maxLen) : '').filter(entry => entry !== '').slice(0, maxItems)
            : []
        const analysis: AiAnalysis = {
          suggestedTitle: cleanText(args.suggestedTitle, 200) || undefined,
          requirementUnderstanding: cleanText(args.requirementUnderstanding, 20_000),
          projectAnalysis: cleanText(args.projectAnalysis, 20_000),
          implementationPlan: cleanList(args.implementationPlan, 100, 2_000),
          affectedModules: cleanList(args.affectedModules, 100, 2_000),
          pendingQuestions: cleanList(args.pendingQuestions, 100, 2_000),
          acceptanceCriteria: cleanList(args.acceptanceCriteria, 100, 2_000)
        }
        if (analysis.requirementUnderstanding === '' || analysis.projectAnalysis === '') {
          return '方案缺少 requirementUnderstanding 或 projectAnalysis，请补充后重新调用。'
        }
        item.aiAnalysis = analysis
        item.creationState = 'pending_confirm'
        pushTimeline(item, { action: 'note', note: '方案生成完成，已生成结构化方案，等待人工确认' })
        touch(foundBoard, item)
        await saveBoards(file)
        return '方案已提交，看板已进入待确认状态。请立即结束本轮执行，等待人工确认或重新分析。'
      })
    }
  })), 'taskboard: analysis tool')

  // Agent 只能通过这个工具改变工作项执行状态。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_progress',
    description: '向需求看板汇报环节完成、阻塞、待交付或已提交。重大任务会停在每个环节等待人工审核；小任务 stage_complete 只记录环节进度，delivery_ready 时卡片进入验收列等待人工确认交付；任何任务最终都必须等待人工确认交付。',
    parameters: {
      outcome: {
        type: 'string',
        enum: ['stage_complete', 'blocked', 'delivery_ready', 'integration_resolved', 'delivered'],
        required: true,
        description: 'stage_complete=当前环节产出完成；blocked=遇到阻塞；delivery_ready=交付物已就绪；delivered=人工确认后已完成代码提交'
      },
      summary: { type: 'string', description: '本次结果摘要（供人工审核与追溯）' },
      commitRef: { type: 'string', description: 'delivered 时必填：本任务代码提交 SHA' },
      previewUrls: { type: 'array', items: { type: 'string' }, description: 'delivery_ready 时可选：改动涉及可见页面时，报告页面预览地址（相对路径如 /taskboard/boards，或完整 http(s) URL，最多 10 个），供人工验收直接打开页面查看效果' }
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
      if (args.outcome === 'integration_resolved') {
        if (item.taskWorkspace === undefined || item.integrationState !== 'conflicted') return '当前任务不在变基冲突处理状态。'
        item.executionState = 'committing'
        item.integrationState = 'integrating'
        pushTimeline(item, { action: 'note', note: summary === undefined ? 'Agent 已完成冲突取舍，继续变基集成' : `Agent 已完成冲突取舍：${summary}` })
        touch(foundBoard, item)
        await saveBoards(file)
        const result = await withLock(`repository:${item.taskWorkspace.root}`, async () => continueTaskIntegration(item.taskWorkspace!))
        if (result.kind === 'conflicted') {
          await requestConflictResolution(ctx, file, foundBoard, item, result)
          return result.rebaseInProgress ? '仍有下一处变基冲突，请继续解决并再次汇报 integration_resolved。' : `集成被外部工作区状态阻塞：${result.reason}`
        }
        item.commitRef = result.commit
        item.integrationState = 'merged'
        item.executionState = 'idle'
        const finalColumn = foundBoard.columns.at(-1)
        if (finalColumn !== undefined && item.status !== finalColumn.id) {
          pushTimeline(item, { action: 'moved', from: item.status, to: finalColumn.id, note: '冲突已自主解决并完成变基集成' })
          item.status = finalColumn.id
        }
        pushTimeline(item, { action: 'note', note: `变基集成完成，提交：${result.commit}；卡片保留在「${finalColumn?.label ?? '完成'}」列，可手动删除归档` })
        touch(foundBoard, item)
        await saveBoards(file)
        if (exec.agent !== undefined) {
          retireDeliveredAgent(ctx, sessionId, exec.agent, lifecycle)
          cleanupResolvedWorkspaceAfterAgentIdle(ctx, exec.agent, foundBoard.projectKey, item.id, lifecycle)
        }
        return `冲突已解决并完成变基集成：${result.commit}。历史会话已保留。`
      }
      if (args.outcome === 'blocked') {
        item.executionState = 'blocked'
        pushTimeline(item, { action: 'note', note: summary === undefined ? '执行阻塞' : `执行阻塞：${summary}` })
        touch(foundBoard, item)
        await saveBoards(file)
        return '已记录阻塞；请等待人工处理后再继续。'
      }
      if (args.outcome === 'delivery_ready') {
        const finalColumn = foundBoard.columns.at(-1)
        if (finalColumn !== undefined && item.status !== finalColumn.id) {
          pushTimeline(item, { action: 'moved', from: item.status, to: finalColumn.id, note: `交付物就绪，进入「${finalColumn.label}」` })
          item.status = finalColumn.id
        }
        item.executionState = 'awaiting-delivery'
        item.deliverySummary = summary
        item.previewUrls = normalizePreviewUrls(args.previewUrls)
        pushTimeline(item, { action: 'note', note: summary === undefined ? '交付物已就绪，等待人工确认' : `交付物已就绪，等待人工确认：${summary}` })
        touch(foundBoard, item)
        await saveBoards(file)
        return '交付物已登记，卡片已进入验收列。请停止执行，等待人工确认交付；确认前严禁提交代码。'
      }
      if (args.outcome === 'delivered') {
        if (item.taskWorkspace !== undefined) return '当前任务由看板自动提交和集成，拒绝 Agent 自报 delivered。请等待人工确认交付。'
        const commitRef = typeof args.commitRef === 'string' ? args.commitRef.trim() : ''
        if (executionStateOf(item) !== 'committing') return '尚未收到人工确认交付，拒绝提交和归档。'
        if (commitRef === '') return 'delivered 必须提供已成功创建的代码提交 SHA。'
        item.commitRef = commitRef
        item.deliverySummary = summary ?? item.deliverySummary
        item.executionState = 'idle'
        if (isAiFlowItem(item)) item.creationState = 'completed'
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
      // 小任务单轮端到端：仅当后面还有中间列时 stage_complete 才推进卡片；
      // 在最终列前的开发列内，环节完成只记录时间线，交付必须通过 delivery_ready 触发。
      // 已在最终列时（手动拖入或旧流程）保留旧协议：按交付处理，等 turn 停稳后开放人工确认。
      if (executionStateOf(item) !== 'running') return '当前工作项不在执行中，忽略本次环节汇报。'
      const next = nextColumn(foundBoard, item)
      if (next === undefined) {
        if (exec.agent === undefined) return '未关联到 Agent，无法确认当前环节是否已经执行完毕。'
        publishAutoDeliveryAfterAgentIdle(exec.agent, sessionId, item.status, note, lifecycle)
        return '已记录最终环节结果。请立即结束本轮执行；会话停稳后看板将开放交付确认。'
      }
      if (next.id === foundBoard.columns.at(-1)?.id) {
        pushTimeline(item, { action: 'note', note: `环节完成：${note}` })
        touch(foundBoard, item)
        await saveBoards(file)
        return `已记录「${columnLabel(foundBoard, item.status)}」环节完成，卡片保持在本列。请继续执行后续环节；全部环节与质量检查完成后调用 taskboard_progress(outcome="delivery_ready")。`
      }
      pushTimeline(item, { action: 'moved', from: item.status, to: next.id, note: `自动推进：${note}` })
      item.status = next.id
      touch(foundBoard, item)
      await saveBoards(file)
      return `已记录「${columnLabel(foundBoard, next.id)}」环节完成，卡片已推进到该列。请继续执行后续环节。`
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

        // ── 页面预览基地址：确保项目 dev server 已启动并返回其基地址 ──
        // 验收框的「🌐 页面预览」相对路径链接解析为 baseUrl + 路径，
        // 直接打开项目真实运行页面查看效果（而非 3080 宿主页面）。
        if (parts.length === 4 && parts[3] === 'preview-base' && method === 'GET') {
          const result = await resolvePreviewBase(board.projectPath)
          send(res, 200, result)
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

        // 已完成任务可手动释放旧版本遗留的临时 Workspace/worktree；会话日志继续保留。
        if (parts.length === 6 && parts[3] === 'history' && parts[5] === 'cleanup' && method === 'POST') {
          const itemId = parts[4] ?? ''
          await withLock(`item:${board.projectKey}:${itemId}`, async () => {
            const item = board.items.find(candidate => candidate.id === itemId && candidate.archived)
            if (item === undefined) throw new HttpError(404, '历史任务不存在')
            await cleanupCompletedWorkspace(ctx, item)
            pushTimeline(item, { action: 'note', note: '人工清理任务临时 Workspace/worktree；会话聊天记录继续保留' })
            touch(board, item)
            await saveBoards(file)
            send(res, 200, { item })
          })
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
              patch.originalRequirement !== undefined || patch.priority !== undefined || patch.labels !== undefined ||
              patch.parentId !== undefined || patch.iteration !== undefined || patch.executionMode !== undefined ||
              patch.status !== undefined
            if (changesExecutionData && executionActive(executionStateOf(item))) {
              send(res, 409, { error: '执行中的工作项不能编辑或手动改变环节' })
              return
            }
            if (patch.status !== undefined && patch.status !== item.status &&
                isAiFlowItem(item) && ['draft', 'analyzing', 'pending_confirm'].includes(creationStateOf(item) ?? 'draft')) {
              send(res, 409, { error: 'AI 创建的工作项在方案确认前不能移出第一列' })
              return
            }
            if (patch.title !== undefined) item.title = patch.title
            if (patch.desc !== undefined) item.desc = patch.desc
            if (patch.originalRequirement !== undefined) {
              item.originalRequirement = patch.originalRequirement
              if (item.creationState === undefined) item.creationState = 'draft'
              // 方案产出前 desc 与原始需求保持同步（卡片/详情展示）。
              if (item.aiAnalysis === undefined) item.desc = patch.originalRequirement
            }
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
          // ── 改动预览：验收时查看本任务修改了哪些文件（独立 HTML 页）──
          if (parts.length === 6 && parts[5] === 'preview' && method === 'GET') {
            const item = findItem(board, parts[4] ?? '')
            const html = await renderItemPreview(board, item)
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(html)
            return
          }
          // 单文件内容页：?path=<仓库相对路径>
          if (parts.length === 7 && parts[5] === 'preview' && parts[6] === 'file' && method === 'GET') {
            const item = findItem(board, parts[4] ?? '')
            const html = await renderFilePreview(board, item, url.searchParams.get('path') ?? '')
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(html)
            return
          }

          // POST run：首次创建会话；阻塞/失败后的重试继续使用同一会话。
          if (parts.length === 6 && parts[5] === 'run' && method === 'POST') {
            const itemId = parts[4] ?? ''
            await withLock(`item:${board.projectKey}:${itemId}`, async () => {
              const item = findItem(board, itemId)
              const state = executionStateOf(item)
              const interruptedBootstrap = state === 'running' && item.sessionId === undefined
              if (item.integrationState === 'conflicted' && item.commitRef !== undefined && item.taskWorkspace !== undefined) {
                await finalizeIsolatedTask(ctx, file, board, item)
                send(res, 200, { item })
                return
              }
              if (executionActive(state) && !interruptedBootstrap) {
                send(res, 409, { error: '工作项已有进行中的执行，请打开关联会话查看状态' })
                return
              }
              // AI 创建流程：必须先分析并确认方案，才能执行。
              if (isAiFlowItem(item)) {
                const creationState = creationStateOf(item) ?? 'draft'
                if (creationState === 'completed') {
                  send(res, 409, { error: '该工作项已完成并集成，无需再次执行' })
                  return
                }
                if (!['confirmed', 'executing'].includes(creationState)) {
                  send(res, 409, { error: '请先完成任务方案生成并确认方案' })
                  return
                }
              }
              const firstRun = item.sessionId === undefined
              // AI 流程项首次执行一定从第一列出发（确认前被锁定），重试时不推进。
              await startExecution(ctx, file, board, item, {
                advanceStatus: firstRun || (isAiFlowItem(item) && item.status === board.columns[0]?.id)
              })
              send(res, 200, { item })
            })
            return
          }

          // POST analyze：创建/复用只读分析会话，Agent 完成后经 taskboard_analysis 工具提交结构化方案。
          if (parts.length === 6 && parts[5] === 'analyze' && method === 'POST') {
            const itemId = parts[4] ?? ''
            await withLock(`item:${board.projectKey}:${itemId}`, async () => {
              const item = findItem(board, itemId)
              if (item.archived) {
                send(res, 409, { error: '工作项已归档' })
                return
              }
              if (!isAiFlowItem(item)) {
                send(res, 409, { error: '该工作项不是 AI 创建流程的工作项' })
                return
              }
              const state = creationStateOf(item) ?? 'draft'
              if (state === 'executing' || state === 'completed') {
                send(res, 409, { error: '已确认执行的工作项不能重新分析' })
                return
              }
              if (executionActive(executionStateOf(item))) {
                send(res, 409, { error: '执行中的工作项不能重新分析' })
                return
              }
              // analyzing 状态允许重入（崩溃/未产出方案时的重试语义）。
              const supplementValue = (body as { supplement?: unknown }).supplement
              const supplement = typeof supplementValue === 'string' && supplementValue.trim() !== '' ? supplementValue.trim() : undefined
              const previous = structuredClone(item)
              if (supplement !== undefined) {
                item.originalRequirement = `${item.originalRequirement ?? ''}\n\n【补充需求】${supplement}`
                item.desc = item.originalRequirement
              }
              item.creationState = 'analyzing'
              item.reviewSummary = undefined
              const firstAnalyze = item.sessionId === undefined
              const sessionId = item.sessionId ?? `taskboard-${board.projectKey}-${item.id}-${randomUUID()}`
              let handle: AgentHandle | undefined
              let workspaceCreatedNow: WorkItem['taskWorkspace']
              let registeredWorkspace: Workspace | undefined
              try {
                if (firstAnalyze && item.taskWorkspace === undefined) {
                  try {
                    const root = await resolveGitRoot(board.projectPath)
                    workspaceCreatedNow = await withLock(`repository:${root}`, async () => prepareTaskWorkspace(board.projectPath, item.id))
                    item.taskWorkspace = workspaceCreatedNow
                    item.integrationState = 'pending'
                    item.gitCheckpoint = undefined
                  } catch (error) {
                    if (!(error instanceof TaskWorkspacePreconditionError)) throw error
                    // 非 Git 项目：只读分析回退到项目主目录（无 worktree）；执行阶段仍受 Git 前置条件约束。
                  }
                }
                const agentCwd = item.taskWorkspace?.path ?? board.projectPath
                const agent = firstAnalyze
                  ? (handle = await createTaskAgent(ctx, sessionId, agentCwd)).agent
                  : await resolveTaskAgent(ctx, sessionId, item.agentPreset)
                if (handle !== undefined) {
                  agentHandles.set(sessionId, handle)
                  if (item.taskWorkspace !== undefined) {
                    registeredWorkspace = await attachTaskSession(
                      ctx,
                      item.taskWorkspace,
                      sessionId,
                      `${board.projectTitle} · ${item.title}`
                    )
                  }
                }
                item.sessionId = sessionId
                item.agentPreset = agent.session.header.agentPreset
                pushTimeline(item, {
                  action: 'note',
                  note: supplement !== undefined
                    ? `补充需求，重新分析：${supplement}`
                    : firstAnalyze
                      ? '开始任务方案生成（只读）'
                      : '重新生成任务方案'
                })
                touch(board, item)
                await saveBoards(file)
                followup(agent, analysisPrompt(board, item, supplement))
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

          // POST confirm-plan：人工确认并冻结方案，立即自动开始执行。
          if (parts.length === 6 && parts[5] === 'confirm-plan' && method === 'POST') {
            const itemId = parts[4] ?? ''
            await withLock(`item:${board.projectKey}:${itemId}`, async () => {
              const item = findItem(board, itemId)
              if (item.archived) {
                send(res, 409, { error: '工作项已归档' })
                return
              }
              if (creationStateOf(item) !== 'pending_confirm') {
                send(res, 409, { error: '当前没有待确认的方案' })
                return
              }
              if (executionActive(executionStateOf(item))) {
                send(res, 409, { error: '工作项已有进行中的执行' })
                return
              }
              const analysis = validateAiAnalysisBody((body as { analysis?: unknown }).analysis)
              const requirementFirstLine = (item.originalRequirement ?? '').split(/\r?\n/)
                .map(line => line.trim())
                .find(line => line !== '') ?? '未命名想法'
              const titleValue = (body as { title?: unknown }).title
              const title = typeof titleValue === 'string' && titleValue.trim() !== ''
                ? titleValue.trim().slice(0, 200)
                : analysis.suggestedTitle !== undefined && analysis.suggestedTitle.trim() !== ''
                  ? analysis.suggestedTitle.trim().slice(0, 200)
                  : item.title.trim() !== ''
                    ? item.title
                    : requirementFirstLine.slice(0, 200)
              item.title = title
              item.aiAnalysis = analysis
              item.frozenPlan = renderPlanMarkdown(title, analysis)
              item.creationState = 'confirmed'
              pushTimeline(item, { action: 'note', note: '人工确认方案并冻结，作为执行唯一依据' })
              touch(board, item)
              await saveBoards(file)
              // 防御加固：清除分析期 Agent 在 worktree 中的误写（快照含用户未提交改动，无损）。
              if (item.taskWorkspace !== undefined) {
                await resetTaskWorkspaceWorkingTree(item.taskWorkspace).catch(() => {})
              }
              // 先落盘 confirmed 再启动执行：启动失败（如非 Git）保持 confirmed 可经 run 重试。
              await startExecution(ctx, file, board, item, {
                advanceStatus: true,
                statusMoveNote: '方案确认后开始执行',
                timelineNote: '方案已确认，自动开始执行'
              })
              send(res, 200, { item })
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
