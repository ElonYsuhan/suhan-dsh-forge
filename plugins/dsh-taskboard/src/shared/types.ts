/**
 * 共享数据模型：node 半（REST 服务）与浏览器半（React UI）共用。
 * 对应 datas/boards.json 的结构。
 */

/** 优先级 */
export type Priority = 'low' | 'medium' | 'high' | 'urgent'

/** Agent 执行策略：小任务自主推进，重大任务逐环节人工审核。 */
export type ExecutionMode = 'auto' | 'review'

/** 工作项执行状态。 */
export type ExecutionState =
  | 'idle'
  | 'running'
  | 'awaiting-review'
  | 'blocked'
  | 'awaiting-delivery'
  | 'committing'
  | 'failed'

/** 任务提交进入目标分支的状态。 */
export type IntegrationState = 'pending' | 'integrating' | 'merged' | 'conflicted'

/** AI 创建流程：创建生命周期状态（仅 originalRequirement 工作项使用）。 */
export type CreationState = 'draft' | 'analyzing' | 'pending_confirm' | 'confirmed' | 'executing' | 'completed'

/** AI 分析产出的结构化方案（工具写入、确认页编辑、冻结渲染的源头）。 */
export interface AiAnalysis {
  /** 建议的卡片标题（AI 生成，人工可在确认页覆盖）。 */
  suggestedTitle?: string | undefined
  /** 需求理解：AI 重新描述用户真正想实现什么。 */
  requirementUnderstanding: string
  /** 项目现状分析：已有相关功能、可复用内容与技术栈现状。 */
  projectAnalysis: string
  /** 实施方案：修改模块 / 新增能力 / 复用 / 实现方式 / 执行顺序。 */
  implementationPlan: string[]
  /** 影响范围：可能受影响的页面、组件、接口、状态、路由等。 */
  affectedModules: string[]
  /** 待确认项：无法从代码或需求确定的重要问题。 */
  pendingQuestions: string[]
  /** 验收标准：明确、可检查的验收条件。 */
  acceptanceCriteria: string[]
}

/** 每个任务独占的 Git worktree/branch。 */
export interface TaskWorkspace {
  /** 原始项目 Git 根目录。 */
  root: string
  /** Agent 实际执行目录。 */
  path: string
  /** 任务独立分支。 */
  branch: string
  /** 创建任务分支时的提交。 */
  baseCommit: string
  /** 最终自动集成的目标分支。 */
  targetBranch: string
  /** Agent 会话实际绑定的临时 DSH Workspace。 */
  workspaceId?: string | undefined
}

/** 任务首次执行前捕获的 Git 工作树基线。 */
export interface GitCheckpoint {
  kind: 'git-tree'
  /** Git 工作树根目录。 */
  root: string
  /** 捕获时 HEAD；尚无提交时为空。 */
  head?: string | undefined
  /** 捕获时真实暂存区 tree。 */
  indexTree: string
  /** 捕获时完整非忽略工作树 tree（包含原有未跟踪文件）。 */
  worktreeTree: string
  /** ISO-8601 捕获时间。 */
  capturedAt: string
}

/** 工作项类型定义（内置 epic/story/task/bug + 自定义） */
export interface ItemTypeDef {
  /** 类型 key（内置：epic/story/task/bug） */
  key: string
  /** 展示名（史诗/需求/任务/缺陷） */
  label: string
  /** 徽标色（CSS 色值） */
  color: string
}

/** 看板环节（列）定义：默认流水线 + 自定义 */
export interface ColumnDef {
  /** 环节 id（稳定，拖拽流转用） */
  id: string
  /** 环节名（待办/分析/开发/测试/上线…） */
  label: string
}

/** 追溯时间线条目：工作项在环节间的每次流转/操作记录 */
export interface TimelineEntry {
  /** ISO-8601 时间 */
  at: string
  /** 动作：created / moved / edited / run / note */
  action: 'created' | 'moved' | 'edited' | 'run' | 'note'
  /** moved：来源环节 id */
  from?: string
  /** moved：目标环节 id */
  to?: string
  /** 备注（edited/note 时） */
  note?: string
  /** run：关联的 agent 会话 id */
  sessionId?: string
}

/** 工作项（史诗/需求/任务/缺陷的统一载体） */
export interface WorkItem {
  /** 稳定 id */
  id: string
  /** 类型 key（见 ItemTypeDef） */
  type: string
  title: string
  desc: string
  /** AI 创建流程：原始需求（草稿期唯一输入；desc 在确认前与其同步）。 */
  originalRequirement?: string | undefined
  /** AI 创建流程生命周期状态；缺省视为 legacy 工作项。 */
  creationState?: CreationState | undefined
  /** 结构化方案（分析产出，确认时合并人工编辑）。 */
  aiAnalysis?: AiAnalysis | undefined
  /** 冻结方案：确认时按固定模板渲染的 markdown，执行唯一依据。 */
  frozenPlan?: string | undefined
  priority: Priority
  labels: string[]
  /** 当前环节（ColumnDef.id） */
  status: string
  /** 追溯父级（bug/task → story → epic） */
  parentId?: string | undefined
  /** 迭代标记（如 2026-08 S2） */
  iteration?: string | undefined
  /** 关联的 agent 会话（任务执行档案） */
  sessionId?: string | undefined
  /** 会话创建时挂载的 DSH Agent preset。 */
  agentPreset?: string | undefined
  /** 执行策略；旧数据缺省时按工作项类型推导。 */
  executionMode?: ExecutionMode | undefined
  /** 当前执行状态；旧数据缺省视为 idle。 */
  executionState?: ExecutionState | undefined
  /** 重大任务当前待审核的环节产出摘要。 */
  reviewSummary?: string | undefined
  /** 最终交付摘要。 */
  deliverySummary?: string | undefined
  /** Agent 完成代码提交后报告的提交引用。 */
  commitRef?: string | undefined
  /** 插件自动提交与集成的状态。 */
  integrationState?: IntegrationState | undefined
  /** 任务隔离的 Git worktree。新任务不再直接修改项目主工作区。 */
  taskWorkspace?: TaskWorkspace | undefined
  /** 集成冲突时自动创建的处理任务。 */
  conflictTaskId?: string | undefined
  /** 当前任务用于处理哪个历史任务的集成冲突。 */
  conflictOf?: string | undefined
  /** 冲突处理任务需要重放的源提交。 */
  conflictSourceCommit?: string | undefined
  /** 冲突处理任务完成后可清理的源分支。 */
  conflictSourceBranch?: string | undefined
  /** 强制关闭时恢复文件所需的任务起始基线。 */
  gitCheckpoint?: GitCheckpoint | undefined
  /** 追溯时间线 */
  timeline: TimelineEntry[]
  createdAt: string
  updatedAt: string
  archived: boolean
}

/** 单个项目的看板 */
export interface Board {
  /** 项目 key（= DSH workspace id） */
  projectKey: string
  /** 项目路径（workspace.path） */
  projectPath: string
  /** 项目展示名（workspace.title） */
  projectTitle: string
  /** 自定义环节（列），默认三列流水线 */
  columns: ColumnDef[]
  /** 工作项类型 */
  itemTypes: ItemTypeDef[]
  items: WorkItem[]
  updatedAt: string
}

/** boards.json 全量结构 */
export interface BoardsFile {
  version: 2
  boards: Record<string, Board>
}

/** 内置类型 */
export const DEFAULT_ITEM_TYPES: ItemTypeDef[] = [
  { key: 'epic', label: '史诗', color: '#9085e9' },
  { key: 'story', label: '需求', color: '#3987e5' },
  { key: 'task', label: '任务', color: '#199e70' },
  { key: 'bug', label: '缺陷', color: '#d95926' }
]

/** 默认三列流水线（可自定义）：想法 → 开发 → 验收提交合并 */
export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'todo', label: '创意想法' },
  { id: 'in-dev', label: '开发落地' },
  { id: 'accept', label: '验收提交合并' }
]

/** 优先级展示名与顺序 */
export const PRIORITIES: Array<{ key: Priority; label: string }> = [
  { key: 'low', label: '低' },
  { key: 'medium', label: '中' },
  { key: 'high', label: '高' },
  { key: 'urgent', label: '紧急' }
]

/** 旧数据兼容：史诗/需求默认重大任务，任务/缺陷默认小任务。 */
export function executionModeOf (item: Pick<WorkItem, 'type' | 'executionMode'>): ExecutionMode {
  return item.executionMode ?? (item.type === 'epic' || item.type === 'story' ? 'review' : 'auto')
}

/** 旧数据兼容：未记录状态的工作项视为尚未执行。 */
export function executionStateOf (item: Pick<WorkItem, 'executionState'>): ExecutionState {
  return item.executionState ?? 'idle'
}

/** 是否 AI 创建流程工作项（有原始需求）。 */
export function isAiFlowItem (item: Pick<WorkItem, 'originalRequirement'>): boolean {
  return item.originalRequirement !== undefined
}

/** AI 创建流程状态：缺省视为 draft；legacy 工作项返回 undefined。 */
export function creationStateOf (item: Pick<WorkItem, 'originalRequirement' | 'creationState'>): CreationState | undefined {
  return isAiFlowItem(item) ? (item.creationState ?? 'draft') : undefined
}

/** AI 创建流程状态展示名。 */
export const CREATION_STATE_LABEL: Record<CreationState, string> = {
  draft: '草稿',
  analyzing: '分析中',
  pending_confirm: '方案待确认',
  confirmed: '已确认',
  executing: '执行中',
  completed: '已完成'
}

/** 新建空看板（首次接触项目时自动创建） */
export function createBoard (key: string, path: string, title: string): Board {
  const now = new Date().toISOString()
  return {
    projectKey: key,
    projectPath: path,
    projectTitle: title,
    columns: DEFAULT_COLUMNS.map(c => ({ ...c })),
    itemTypes: DEFAULT_ITEM_TYPES.map(t => ({ ...t })),
    items: [],
    updatedAt: now
  }
}
