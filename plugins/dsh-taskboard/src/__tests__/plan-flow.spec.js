import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const checkpointMocks = vi.hoisted(() => ({
  capture: vi.fn(async cwd => ({
    kind: 'git-tree',
    root: cwd,
    indexTree: 'index-tree',
    worktreeTree: 'worktree-tree',
    capturedAt: '2026-08-15T00:00:00.000Z'
  })),
  restore: vi.fn(async () => {})
}))

const workspaceMocks = vi.hoisted(() => ({
  resolve: vi.fn(async cwd => cwd),
  prepare: vi.fn(async (cwd, itemId) => ({
    root: cwd,
    path: `${cwd}/worktrees/${itemId}`,
    branch: `dsh-taskboard/${itemId}`,
    baseCommit: 'base-commit',
    targetBranch: 'main'
  })),
  commit: vi.fn(async () => 'task-commit'),
  integrate: vi.fn(async () => ({ kind: 'merged', commit: 'integrated-commit' })),
  continueIntegration: vi.fn(async () => ({ kind: 'merged', commit: 'resolved-commit' })),
  discard: vi.fn(async () => {}),
  deleteBranch: vi.fn(async () => {}),
  reset: vi.fn(async () => {})
}))

vi.mock('@deepseek-ai/dsh-agent', async importOriginal => ({
  ...await importOriginal(),
  installModelSelection: vi.fn()
}))

vi.mock('../gitCheckpoint.ts', () => ({
  captureGitCheckpoint: checkpointMocks.capture,
  restoreGitCheckpoint: checkpointMocks.restore
}))

vi.mock('../taskWorkspace.ts', async importOriginal => ({
  ...await importOriginal(),
  prepareTaskWorkspace: workspaceMocks.prepare,
  resolveGitRoot: workspaceMocks.resolve,
  commitTaskWorkspace: workspaceMocks.commit,
  integrateTaskWorkspace: workspaceMocks.integrate,
  continueTaskIntegration: workspaceMocks.continueIntegration,
  discardTaskWorkspace: workspaceMocks.discard,
  deleteTaskBranch: workspaceMocks.deleteBranch,
  resetTaskWorkspaceWorkingTree: workspaceMocks.reset
}))

let apply
let dataDir

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-plan-test-'))
  process.env.DSH_TASKBOARD_DATA = join(dataDir, 'boards.json')
  ;({ apply } = await import('../index.ts'))
})

afterAll(async () => {
  delete process.env.DSH_TASKBOARD_DATA
  await rm(dataDir, { recursive: true, force: true })
})

function request (method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    async * [Symbol.asyncIterator] () {
      yield * chunks
    }
  }
}

function response () {
  return {
    status: 0,
    body: undefined,
    writeHead (status) {
      this.status = status
    },
    end (body) {
      this.body = JSON.parse(body)
    }
  }
}

const ANALYSIS = {
  suggestedTitle: '登录功能',
  requirementUnderstanding: '为系统增加账号密码登录，并保持登录状态',
  projectAnalysis: '当前无任何登录模块；已有 api client 可复用',
  implementationPlan: ['修改 auth.ts 增加登录接口', '新增 login.vue 登录页'],
  affectedModules: ['auth.ts', 'router.ts'],
  pendingQuestions: ['登录态有效期如何设置？'],
  acceptanceCriteria: ['输入正确账号密码可登录', '刷新后保持登录']
}

describe('AI 创建流程（先分析、后执行）', () => {
  it('草稿创建 → AI 分析 → 方案确认 → 自动执行，并强制各阶段守卫', async () => {
    let route
    const toolsByName = {}
    let liveAgent
    const followup = vi.fn()
    const idleResolvers = []
    const attachSession = vi.fn(async () => {})
    const detachSession = vi.fn(async () => {})
    const registeredByPath = new Map()
    const registeredById = new Map()
    let workspaceCounter = 0
    const createWorkspace = vi.fn(async (path, title) => {
      const workspace = {
        id: `task-workspace-${++workspaceCounter}`,
        path,
        title,
        sessionIds: [],
        attachSession,
        detachSession
      }
      registeredByPath.set(path, workspace)
      registeredById.set(workspace.id, workspace)
      return workspace
    })
    const deleteWorkspace = vi.fn(async id => {
      const workspace = registeredById.get(id)
      if (workspace === undefined) return false
      registeredById.delete(id)
      registeredByPath.delete(workspace.path)
      return true
    })
    const archiveSession = vi.fn(async () => {})
    const mountPreset = vi.fn(async () => {})
    const logError = vi.fn()
    const create = vi.fn(async options => {
      await options.setup({})
      let resolveAgentIdle
      const agentIdle = new Promise(resolve => {
        resolveAgentIdle = resolve
      })
      idleResolvers.push(resolveAgentIdle)
      liveAgent = {
        id: options.sessionId,
        session: { header: { agentPreset: options.meta.agentPreset } },
        followup,
        whenIdle: vi.fn(() => agentIdle),
        cancel: vi.fn(() => resolveAgentIdle())
      }
      return { agent: liveAgent, dispose: vi.fn(async () => {}) }
    })
    const ctx = {
      logger: vi.fn(() => ({ error: logError })),
      effect (factory) {
        factory()
      },
      get (name) {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
        if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }), mount: mountPreset }
        return undefined
      },
      tools: {
        register (tool) {
          toolsByName[tool.name] = tool
          return () => {}
        }
      },
      webServer: {
        register (registration) {
          route = registration.handler
          return () => {}
        }
      },
      workspaceRegistry: {
        list: () => [{ id: 'workspace-1', path: dataDir, title: '测试项目', sessionIds: [] }],
        resolveByPath: async path => registeredByPath.get(path),
        create: createWorkspace,
        get: id => registeredById.get(id),
        delete: deleteWorkspace,
        archiveSession
      },
      agents: { create, get: vi.fn(() => liveAgent) },
      sessions: { flush: vi.fn(async () => {}) }
    }
    apply(ctx)

    const boardsResponse = response()
    await route(request('GET', '/taskboard/boards'), boardsResponse)
    expect(boardsResponse.status).toBe(200)

    const findItem = async id => {
      const boards = response()
      await route(request('GET', '/taskboard/boards'), boards)
      return boards.body.boards['workspace-1'].items.find(item => item.id === id)
    }

    // ── 草稿创建 ────────────────────────────────────────────
    const requirement = '给系统加个登录功能，账号密码登录，登录后保持登录状态。'
    const draftResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task',
      title: '',
      desc: '',
      priority: 'medium',
      labels: [],
      status: 'todo',
      executionMode: 'auto',
      originalRequirement: requirement
    }), draftResponse)
    expect(draftResponse.status).toBe(200)
    const draft = draftResponse.body.item
    expect(draft.status).toBe('todo')
    expect(draft.title).toBe(requirement)
    expect(draft.desc).toBe(requirement)
    expect(draft.originalRequirement).toBe(requirement)
    expect(draft.creationState).toBe('draft')
    expect(draft.executionState).toBe('idle')

    const emptyResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task', title: '', desc: '', priority: 'medium', labels: [], status: 'todo', executionMode: 'auto'
    }), emptyResponse)
    expect(emptyResponse.status).toBe(400)
    expect(emptyResponse.body.error).toContain('标题或想法描述')

    // 强制第一列：即便请求其他列也落在创意想法。
    const forcedColumnResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task', title: 't', desc: '', priority: 'medium', labels: [], status: 'in-dev', executionMode: 'auto',
      originalRequirement: '强制首列'
    }), forcedColumnResponse)
    expect(forcedColumnResponse.status).toBe(200)
    expect(forcedColumnResponse.body.item.status).toBe('todo')

    // 旧工作项（无 originalRequirement）不进入 AI 流程。
    const legacyResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task', title: '旧工作项', desc: '旧描述', priority: 'medium', labels: [], status: 'todo', executionMode: 'auto'
    }), legacyResponse)
    expect(legacyResponse.status).toBe(200)
    expect(legacyResponse.body.item.creationState).toBeUndefined()

    // ── 未确认前禁止执行 ─────────────────────────────────────
    const gateResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${draft.id}/run`), gateResponse)
    expect(gateResponse.status).toBe(409)
    expect(gateResponse.body.error).toContain('AI 分析')

    // 旧工作项分析 → 409
    const legacyAnalyzeResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${legacyResponse.body.item.id}/analyze`), legacyAnalyzeResponse)
    expect(legacyAnalyzeResponse.status).toBe(409)
    expect(legacyAnalyzeResponse.body.error).toContain('不是 AI 创建流程')

    // ── AI 分析 ─────────────────────────────────────────────
    const analyzeResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${draft.id}/analyze`), analyzeResponse)
    expect(analyzeResponse.status).toBe(200)
    expect(analyzeResponse.body.item.creationState).toBe('analyzing')
    expect(analyzeResponse.body.item.sessionId).toBeDefined()
    expect(analyzeResponse.body.item.taskWorkspace).toBeDefined()
    expect(analyzeResponse.body.item.integrationState).toBe('pending')
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0].meta.cwd).toBe(`${dataDir}/worktrees/${draft.id}`)
    expect(attachSession).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls[0][0].content[0].text).toContain(requirement)
    expect(followup.mock.calls[0][0].content[0].text).toContain('taskboard_analysis')

    // 分析中的 status 修改被禁止
    const moveWhileAnalyzing = response()
    await route(request('PATCH', `/taskboard/boards/workspace-1/items/${draft.id}`, { status: 'in-dev' }), moveWhileAnalyzing)
    expect(moveWhileAnalyzing.status).toBe(409)
    expect(moveWhileAnalyzing.body.error).toContain('确认前')

    // ── 工具提交方案 → 待确认 ────────────────────────────────
    const analysisTool = toolsByName.taskboard_analysis
    const progressTool = toolsByName.taskboard_progress
    expect(analysisTool).toBeDefined()
    expect(progressTool).toBeDefined()
    const toolResult = await analysisTool.execute(ANALYSIS, { agent: liveAgent })
    expect(toolResult).toContain('待确认')
    let updated = await findItem(draft.id)
    expect(updated.creationState).toBe('pending_confirm')
    expect(updated.aiAnalysis.requirementUnderstanding).toBe(ANALYSIS.requirementUnderstanding)

    const duplicateTool = await analysisTool.execute(ANALYSIS, { agent: liveAgent })
    expect(duplicateTool).toContain('不处于分析中')

    const progressDuringConfirm = await progressTool.execute({ outcome: 'stage_complete', summary: '不应生效' }, { agent: liveAgent })
    expect(progressDuringConfirm).toContain('不在执行中')

    // 待确认时 run 仍被拦截
    const gatePendingResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${draft.id}/run`), gatePendingResponse)
    expect(gatePendingResponse.status).toBe(409)
    expect(gatePendingResponse.body.error).toContain('AI 分析')

    // ── 补充需求，重新分析 ────────────────────────────────────
    const reanalyzeResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${draft.id}/analyze`, { supplement: '还要支持验证码登录' }), reanalyzeResponse)
    expect(reanalyzeResponse.status).toBe(200)
    expect(reanalyzeResponse.body.item.creationState).toBe('analyzing')
    expect(reanalyzeResponse.body.item.originalRequirement).toContain('【补充需求】还要支持验证码登录')
    expect(followup).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce() // 复用同一会话
    const revised = { ...ANALYSIS, pendingQuestions: ['登录态有效期如何设置？', '验证码由哪家服务提供？'] }
    await analysisTool.execute(revised, { agent: liveAgent })

    // ── 确认并执行 ───────────────────────────────────────────
    const confirmResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${draft.id}/confirm-plan`, {
      title: '登录功能',
      analysis: revised
    }), confirmResponse)
    expect(confirmResponse.status).toBe(200)
    const confirmed = confirmResponse.body.item
    expect(confirmed.title).toBe('登录功能')
    expect(confirmed.creationState).toBe('executing')
    expect(confirmed.executionState).toBe('running')
    expect(confirmed.status).toBe('in-dev')
    expect(confirmed.frozenPlan).toContain('# 登录功能')
    expect(confirmed.frozenPlan).toContain('## 需求理解')
    expect(confirmed.frozenPlan).toContain('1. 修改 auth.ts 增加登录接口')
    expect(confirmed.frozenPlan).toContain('- 验证码由哪家服务提供？')
    expect(create).toHaveBeenCalledOnce() // 执行复用分析会话
    expect(followup).toHaveBeenCalledTimes(3)
    expect(followup.mock.calls[2][0].content[0].text).toContain('【执行依据】')
    expect(followup.mock.calls[2][0].content[0].text).toContain('## 实施方案')
    expect(workspaceMocks.reset).toHaveBeenCalledOnce() // 确认时防御性复位 worktree

    // 执行中不能改原始需求
    const patchWhileRunning = response()
    await route(request('PATCH', `/taskboard/boards/workspace-1/items/${draft.id}`, { originalRequirement: '篡改' }), patchWhileRunning)
    expect(patchWhileRunning.status).toBe(409)

    // ── 交付 → 完成流转 ─────────────────────────────────────
    // 释放执行会话的 whenIdle（交付确认后的 preserveTaskSession 会等待会话停稳）。
    idleResolvers[0]()
    await progressTool.execute({ outcome: 'delivery_ready', summary: '交付完成' }, { agent: liveAgent })
    updated = await findItem(draft.id)
    expect(updated.status).toBe('accept')
    expect(updated.executionState).toBe('awaiting-delivery')
    const deliverResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${draft.id}/confirm-delivery`), deliverResponse)
    expect(deliverResponse.status).toBe(200)
    expect(deliverResponse.body.item.integrationState).toBe('merged')
    expect(deliverResponse.body.item.creationState).toBe('completed')

    // ── 分析中删除草稿：Agent 停止、worktree 清理 ─────────────
    const delDraftResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task', title: '', desc: '', priority: 'medium', labels: [], status: 'todo', executionMode: 'auto',
      originalRequirement: '临时草稿'
    }), delDraftResponse)
    const delDraftId = delDraftResponse.body.item.id
    await route(request('POST', `/taskboard/boards/workspace-1/items/${delDraftId}/analyze`), response())
    const deleteResponse = response()
    await route(request('DELETE', `/taskboard/boards/workspace-1/items/${delDraftId}`), deleteResponse)
    expect(deleteResponse.status).toBe(200)
    expect(deleteResponse.body.item.archived).toBe(true)
    expect(liveAgent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(workspaceMocks.discard).toHaveBeenCalled()

    // ── 非 Git 项目：分析回退主目录，确认执行被前置条件拦截 ────
    const nonGitDraftResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task', title: '', desc: '', priority: 'medium', labels: [], status: 'todo', executionMode: 'auto',
      originalRequirement: '非 Git 项目需求'
    }), nonGitDraftResponse)
    const nonGitId = nonGitDraftResponse.body.item.id
    const { TaskWorkspacePreconditionError } = await import('../taskWorkspace.ts')
    const nonGitError = new TaskWorkspacePreconditionError('当前工作区不是 Git 仓库。')
    workspaceMocks.resolve.mockRejectedValueOnce(nonGitError) // analyze 回退
    workspaceMocks.resolve.mockRejectedValueOnce(nonGitError) // confirm-plan 的执行启动拦截
    const nonGitAnalyzeResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${nonGitId}/analyze`), nonGitAnalyzeResponse)
    expect(nonGitAnalyzeResponse.status).toBe(200)
    expect(nonGitAnalyzeResponse.body.item.taskWorkspace).toBeUndefined()
    expect(create.mock.calls[2][0].meta.cwd).toBe(dataDir) // 回退项目主目录
    await analysisTool.execute(ANALYSIS, { agent: liveAgent })
    const nonGitConfirmResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${nonGitId}/confirm-plan`, { analysis: ANALYSIS }), nonGitConfirmResponse)
    expect(nonGitConfirmResponse.status).toBe(409)
    expect(nonGitConfirmResponse.body.error).toContain('不是 Git 仓库')
    const nonGitItem = await findItem(nonGitId)
    expect(nonGitItem.creationState).toBe('confirmed') // 保持已确认，可重试
    expect(nonGitItem.frozenPlan).toBeDefined()
    // Git 恢复后经 run 重试：补齐 worktree 并新建执行会话
    const retryRunResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${nonGitId}/run`), retryRunResponse)
    expect(retryRunResponse.status).toBe(200)
    expect(retryRunResponse.body.item.status).toBe('in-dev')
    expect(retryRunResponse.body.item.creationState).toBe('executing')
    expect(create).toHaveBeenCalledTimes(4) // 分析(×3) + 补齐 worktree 后换新执行会话
  })
})
