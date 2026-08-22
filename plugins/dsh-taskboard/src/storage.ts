import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { BoardsFile } from './shared/types.ts'

export interface TaskboardDataPaths {
  dataFile: string
  legacyDataFile?: string | undefined
}

export class TaskboardDataError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'TaskboardDataError'
  }
}

const MAX_DATA_BYTES = 64 * 1024 * 1024
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])
const EXECUTION_MODES = new Set(['auto', 'review'])
const EXECUTION_STATES = new Set(['idle', 'running', 'awaiting-review', 'blocked', 'awaiting-delivery', 'committing', 'failed'])
const INTEGRATION_STATES = new Set(['pending', 'integrating', 'merged', 'conflicted'])
const CREATION_STATES = new Set(['draft', 'analyzing', 'pending_confirm', 'confirmed', 'executing', 'completed'])
const TIMELINE_ACTIONS = new Set(['created', 'moved', 'edited', 'run', 'note'])

function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validColumn (value: unknown): boolean {
  return isObject(value) && typeof value.id === 'string' && typeof value.label === 'string'
}

function validItemType (value: unknown): boolean {
  return isObject(value) && typeof value.key === 'string' && typeof value.label === 'string' && typeof value.color === 'string'
}

function validTimelineEntry (value: unknown): boolean {
  return isObject(value) && typeof value.at === 'string' && typeof value.action === 'string' &&
    TIMELINE_ACTIONS.has(value.action) && optionalString(value.from) && optionalString(value.to) &&
    optionalString(value.note) && optionalString(value.sessionId)
}

function optionalString (value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalEnum (value: unknown, allowed: Set<string>): boolean {
  return value === undefined || (typeof value === 'string' && allowed.has(value))
}

function validTaskWorkspace (value: unknown): boolean {
  return value === undefined || (isObject(value) && typeof value.root === 'string' && typeof value.path === 'string' &&
    typeof value.branch === 'string' && typeof value.baseCommit === 'string' && typeof value.targetBranch === 'string' &&
    optionalString(value.workspaceId))
}

function validGitCheckpoint (value: unknown): boolean {
  return value === undefined || (isObject(value) && value.kind === 'git-tree' && typeof value.root === 'string' &&
    optionalString(value.head) && typeof value.indexTree === 'string' && typeof value.worktreeTree === 'string' &&
    typeof value.capturedAt === 'string')
}

function validStringList (value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validDependencyList (value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(entry => isObject(entry) &&
    typeof entry.taskId === 'string' && (entry.type === 'before' || entry.type === 'after' || entry.type === 'parallel')))
}

function validAiAnalysis (value: unknown): boolean {
  return value === undefined || (isObject(value) && optionalString(value.suggestedTitle) &&
    typeof value.requirementUnderstanding === 'string' && typeof value.projectAnalysis === 'string' &&
    validStringList(value.implementationPlan) && validStringList(value.affectedModules) &&
    validStringList(value.pendingQuestions) && validStringList(value.acceptanceCriteria))
}

function validItem (value: unknown): boolean {
  if (!isObject(value)) return false
  return typeof value.id === 'string' && typeof value.type === 'string' && typeof value.title === 'string' &&
    typeof value.desc === 'string' && optionalString(value.originalRequirement) && optionalEnum(value.creationState, CREATION_STATES) &&
    validAiAnalysis(value.aiAnalysis) && optionalString(value.frozenPlan) &&
    typeof value.priority === 'string' && PRIORITIES.has(value.priority) && Array.isArray(value.labels) &&
    value.labels.every(label => typeof label === 'string') && typeof value.status === 'string' &&
    Array.isArray(value.timeline) && value.timeline.every(validTimelineEntry) &&
    typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' &&
    typeof value.archived === 'boolean' && optionalString(value.parentId) && optionalString(value.iteration) &&
    optionalString(value.sessionId) && optionalString(value.agentPreset) && optionalEnum(value.executionMode, EXECUTION_MODES) &&
    optionalEnum(value.executionState, EXECUTION_STATES) && optionalString(value.reviewSummary) &&
    optionalString(value.deliverySummary) && (value.previewUrls === undefined || validStringList(value.previewUrls)) && validDependencyList(value.dependencies) && optionalString(value.commitRef) &&
    optionalEnum(value.integrationState, INTEGRATION_STATES) && validTaskWorkspace(value.taskWorkspace) &&
    optionalString(value.conflictTaskId) && optionalString(value.conflictOf) && optionalString(value.conflictSourceCommit) &&
    optionalString(value.conflictSourceBranch) && validGitCheckpoint(value.gitCheckpoint)
}

function validBoardsFile (value: unknown): value is BoardsFile {
  if (!isObject(value) || value.version !== 2 || !isObject(value.boards)) return false
  return Object.values(value.boards).every(board => isObject(board) &&
    typeof board.projectKey === 'string' && typeof board.projectPath === 'string' &&
    typeof board.projectTitle === 'string' && Array.isArray(board.columns) && board.columns.every(validColumn) &&
    Array.isArray(board.itemTypes) && board.itemTypes.every(validItemType) &&
    Array.isArray(board.items) && board.items.every(validItem) && typeof board.updatedAt === 'string')
}

/** 拒绝损坏或不兼容的数据，避免把坏结构写回并扩大损失。 */
export function parseBoardsFile (text: string): BoardsFile {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new TaskboardDataError('看板数据不是有效 JSON')
  }
  if (!validBoardsFile(value)) throw new TaskboardDataError('看板数据版本、项目或工作项结构无效')
  return value
}

async function readCandidate (path: string): Promise<BoardsFile | null> {
  try {
    const info = await stat(path)
    if (info.size > MAX_DATA_BYTES) throw new TaskboardDataError('看板数据超过 64 MiB 安全限制')
    return parseBoardsFile(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 运行数据固定放在 DSH home；包目录只作为旧版本迁移源。 */
export function taskboardDataPaths (moduleUrl: string, env: NodeJS.ProcessEnv = process.env): TaskboardDataPaths {
  if (env.DSH_TASKBOARD_DATA !== undefined && env.DSH_TASKBOARD_DATA.trim() !== '') {
    return { dataFile: resolve(env.DSH_TASKBOARD_DATA) }
  }
  return {
    dataFile: resolve(resolveDshHome(undefined, env), 'storages', 'dsh-taskboard', 'boards.json'),
    legacyDataFile: resolve(dirname(fileURLToPath(moduleUrl)), '..', 'datas', 'boards.json')
  }
}

/** 优先读取稳定文件；不存在时读取旧包目录数据，交由调用方复制迁移。 */
export async function readStoredBoards (paths: TaskboardDataPaths): Promise<{ file: BoardsFile; source: 'primary' | 'backup' | 'legacy' } | null> {
  try {
    const primary = await readCandidate(paths.dataFile)
    if (primary !== null) return { file: primary, source: 'primary' }
  } catch (error) {
    if (!(error instanceof TaskboardDataError)) throw error
    let backup: BoardsFile | null = null
    try {
      backup = await readCandidate(`${paths.dataFile}.bak`)
    } catch (backupError) {
      if (!(backupError instanceof TaskboardDataError)) throw backupError
    }
    if (backup !== null) return { file: backup, source: 'backup' }
    throw error
  }
  if (paths.legacyDataFile === undefined || paths.legacyDataFile === paths.dataFile) return null
  const legacy = await readCandidate(paths.legacyDataFile)
  return legacy === null ? null : { file: legacy, source: 'legacy' }
}
