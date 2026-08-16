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
  deleteBranch: vi.fn(async () => {})
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
  deleteTaskBranch: workspaceMocks.deleteBranch
}))

let apply
let dataDir

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-test-'))
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

describe('taskboard execution workflow', () => {
  it('creates a complete Agent, attaches it once, and rejects concurrent execution', async () => {
    let route
    let taskTool
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
          taskTool = tool
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

    const preconditionCreateResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task',
      title: '非 Git 工作区错误提示',
      desc: '',
      priority: 'medium',
      labels: [],
      status: 'todo',
      executionMode: 'auto'
    }), preconditionCreateResponse)
    const { TaskWorkspacePreconditionError } = await import('../taskWorkspace.ts')
    workspaceMocks.resolve.mockRejectedValueOnce(new TaskWorkspacePreconditionError('当前工作区不是 Git 仓库。'))
    const preconditionRunResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${preconditionCreateResponse.body.item.id}/run`), preconditionRunResponse)
    expect(preconditionRunResponse.status).toBe(409)
    expect(preconditionRunResponse.body.error).toContain('不是 Git 仓库')
    expect(workspaceMocks.prepare).not.toHaveBeenCalled()

    const diagnosticCreateResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task',
      title: '运行失败可诊断',
      desc: '',
      priority: 'medium',
      labels: [],
      status: 'todo',
      executionMode: 'auto'
    }), diagnosticCreateResponse)
    create.mockRejectedValueOnce(new Error('secret internal detail'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const diagnosticRunResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${diagnosticCreateResponse.body.item.id}/run`), diagnosticRunResponse)
    expect(diagnosticRunResponse.status).toBe(500)
    expect(diagnosticRunResponse.body.error).toMatch(/^任务看板内部错误（诊断编号：[0-9a-f]{8}）$/)
    expect(diagnosticRunResponse.body.error).not.toContain('secret internal detail')
    expect(logError).toHaveBeenCalledWith('request failed [%s]', expect.stringMatching(/^[0-9a-f]{8}$/), expect.objectContaining({
      message: 'secret internal detail'
    }))
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^\[dsh-taskboard\] request failed \[[0-9a-f]{8}\]: Error: secret internal detail\n$/))
    stderr.mockRestore()
    create.mockClear()
    workspaceMocks.prepare.mockClear()
    workspaceMocks.discard.mockClear()
    workspaceMocks.resolve.mockClear()

    const createResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'story',
      title: '实现审核工作流',
      desc: '逐环节审核',
      priority: 'high',
      labels: [],
      status: 'todo',
      executionMode: 'review'
    }), createResponse)
    const itemId = createResponse.body.item.id

    const runResponse = response()
    const simultaneousResponse = response()
    await Promise.all([
      route(request('POST', `/taskboard/boards/workspace-1/items/${itemId}/run`), runResponse),
      route(request('POST', `/taskboard/boards/workspace-1/items/${itemId}/run`), simultaneousResponse)
    ])
    expect(runResponse.status).toBe(200)
    expect(simultaneousResponse.status).toBe(409)
    expect(runResponse.body.item.executionState).toBe('running')
    expect(runResponse.body.item.status).toBe('analysis')
    expect(runResponse.body.item.agentPreset).toBe('standard')
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0].agentOptions).toEqual({ provider: 'test', model: 'test-model' })
    expect(create.mock.calls[0][0].meta.agentPreset).toBe('standard')
    expect(create.mock.calls[0][0].meta.cwd).toBe(`${dataDir}/worktrees/${itemId}`)
    expect(mountPreset).toHaveBeenCalledOnce()
    expect(createWorkspace).toHaveBeenCalledWith(`${dataDir}/worktrees/${itemId}`, '测试项目 · 实现审核工作流')
    expect(attachSession).toHaveBeenCalledOnce()
    expect(runResponse.body.item.taskWorkspace.workspaceId).toBe('task-workspace-1')

    await deleteWorkspace('task-workspace-1')
    deleteWorkspace.mockClear()
    createWorkspace.mockClear()
    attachSession.mockClear()
    const recoveredRegistrationResponse = response()
    await route(request('GET', '/taskboard/boards'), recoveredRegistrationResponse)
    const recoveredRegistrationItem = recoveredRegistrationResponse.body.boards['workspace-1'].items.find(item => item.id === itemId)
    expect(createWorkspace).toHaveBeenCalledWith(`${dataDir}/worktrees/${itemId}`, '测试项目 · 实现审核工作流')
    expect(attachSession).toHaveBeenCalledOnce()
    expect(recoveredRegistrationItem.taskWorkspace.workspaceId).toBe('task-workspace-2')
    expect(followup).toHaveBeenCalledOnce()
    expect(workspaceMocks.prepare).toHaveBeenCalledOnce()

    const repeatedResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${itemId}/run`), repeatedResponse)
    expect(repeatedResponse.status).toBe(409)
    expect(create).toHaveBeenCalledOnce()

    const toolResult = await taskTool.execute({
      outcome: 'stage_complete',
      summary: '分析方案可供审核'
    }, { agent: liveAgent })
    expect(toolResult).toContain('会话完全停稳后')

    const runningResponse = response()
    await route(request('GET', '/taskboard/boards'), runningResponse)
    const runningItem = runningResponse.body.boards['workspace-1'].items.find(item => item.id === itemId)
    expect(runningItem.executionState).toBe('running')
    expect(runningItem.reviewSummary).toBeUndefined()

    const prematureApproveResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${itemId}/approve`), prematureApproveResponse)
    expect(prematureApproveResponse.status).toBe(409)

    idleResolvers.shift()()
    await vi.waitFor(async () => {
      const reviewResponse = response()
      await route(request('GET', '/taskboard/boards'), reviewResponse)
      const reviewingItem = reviewResponse.body.boards['workspace-1'].items.find(item => item.id === itemId)
      expect(reviewingItem.executionState).toBe('awaiting-review')
      expect(reviewingItem.reviewSummary).toBe('分析方案可供审核')
    })

    const reviewResponse = response()
    await route(request('GET', '/taskboard/boards'), reviewResponse)
    const reviewingItem = reviewResponse.body.boards['workspace-1'].items.find(item => item.id === itemId)
    expect(reviewingItem.executionState).toBe('awaiting-review')
    expect(reviewingItem.reviewSummary).toBe('分析方案可供审核')

    const approveResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${itemId}/approve`), approveResponse)
    expect(approveResponse.status).toBe(200)
    expect(approveResponse.body.item.status).toBe('scheduled')
    expect(approveResponse.body.item.executionState).toBe('running')
    expect(followup).toHaveBeenCalledTimes(2)

    await taskTool.execute({
      outcome: 'delivery_ready',
      summary: '代码与测试均已准备好'
    }, { agent: liveAgent })
    const deliveryResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${itemId}/confirm-delivery`), deliveryResponse)
    expect(deliveryResponse.body.item.executionState).toBe('idle')
    expect(deliveryResponse.body.item.integrationState).toBe('merged')
    expect(deliveryResponse.body.item.commitRef).toBe('integrated-commit')
    expect(workspaceMocks.commit).toHaveBeenCalledOnce()
    expect(workspaceMocks.integrate).toHaveBeenCalledOnce()
    expect(archiveSession).not.toHaveBeenCalled()
    expect(detachSession).toHaveBeenCalledOnce()
    expect(deleteWorkspace).toHaveBeenCalledOnce()
    expect(workspaceMocks.discard).toHaveBeenCalledOnce()

    const archivedResponse = response()
    await route(request('GET', '/taskboard/boards/workspace-1/history?offset=0&limit=50'), archivedResponse)
    const archivedItem = archivedResponse.body.items.find(item => item.id === itemId)
    expect(archivedItem.archived).toBe(true)
    expect(archivedItem.commitRef).toBe('integrated-commit')
    expect(archivedResponse.body.total).toBe(1)

    const createAutoResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task',
      title: '自动任务单轮完成',
      desc: '一个 turn 完成端到端交付',
      priority: 'medium',
      labels: [],
      status: 'todo',
      executionMode: 'auto'
    }), createAutoResponse)
    const autoItemId = createAutoResponse.body.item.id

    const runAutoResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${autoItemId}/run`), runAutoResponse)
    const autoAgent = liveAgent
    expect(runAutoResponse.body.item.status).toBe('in-dev')

    const firstAdvance = await taskTool.execute({ outcome: 'stage_complete', summary: '分析完成' }, { agent: autoAgent })
    const duplicateAdvance = await taskTool.execute({ outcome: 'stage_complete', summary: '重复调用' }, { agent: autoAgent })
    expect(firstAdvance).toContain('会话停稳后看板将开放最终交付确认')
    expect(duplicateAdvance).toContain('会话停稳后看板将开放最终交付确认')

    const autoRunningResponse = response()
    await route(request('GET', '/taskboard/boards'), autoRunningResponse)
    const autoRunningItem = autoRunningResponse.body.boards['workspace-1'].items.find(item => item.id === autoItemId)
    expect(autoRunningItem.status).toBe('in-dev')
    expect(autoRunningItem.executionState).toBe('running')

    idleResolvers.shift()()
    await vi.waitFor(async () => {
      const autoAdvancedResponse = response()
      await route(request('GET', '/taskboard/boards'), autoAdvancedResponse)
      const autoAdvancedItem = autoAdvancedResponse.body.boards['workspace-1'].items.find(item => item.id === autoItemId)
      expect(autoAdvancedItem.status).toBe('in-dev')
      expect(autoAdvancedItem.executionState).toBe('awaiting-delivery')
      expect(followup).toHaveBeenCalledTimes(3)
    })

    const forceCloseResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${autoItemId}/force-close`), forceCloseResponse)
    expect(forceCloseResponse.status).toBe(200)
    expect(forceCloseResponse.body.item.archived).toBe(true)
    expect(autoAgent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(workspaceMocks.discard).toHaveBeenCalledTimes(2)
    expect(archiveSession).toHaveBeenCalledOnce()

    const createDeleteResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task',
      title: '执行中也能删除',
      desc: '删除前停止并回退',
      priority: 'medium',
      labels: [],
      status: 'todo',
      executionMode: 'auto'
    }), createDeleteResponse)
    const deleteItemId = createDeleteResponse.body.item.id

    const runDeleteResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${deleteItemId}/run`), runDeleteResponse)
    const deleteAgent = liveAgent
    expect(runDeleteResponse.body.item.executionState).toBe('running')

    const deleteResponse = response()
    await route(request('DELETE', `/taskboard/boards/workspace-1/items/${deleteItemId}`), deleteResponse)
    expect(deleteResponse.status).toBe(200)
    expect(deleteResponse.body.rolledBack).toBe(true)
    expect(deleteResponse.body.item.archived).toBe(true)
    expect(deleteAgent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(workspaceMocks.discard).toHaveBeenCalledTimes(3)
    expect(archiveSession).toHaveBeenCalledTimes(2)

    const createPlainResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task',
      title: '未执行任务直接删除',
      desc: '',
      priority: 'low',
      labels: [],
      status: 'todo',
      executionMode: 'auto'
    }), createPlainResponse)
    const plainItemId = createPlainResponse.body.item.id
    const deletePlainResponse = response()
    await route(request('DELETE', `/taskboard/boards/workspace-1/items/${plainItemId}`), deletePlainResponse)
    expect(deletePlainResponse.status).toBe(200)
    expect(deletePlainResponse.body.rolledBack).toBe(false)
    expect(deletePlainResponse.body.item.archived).toBe(true)

    const createConflictResponse = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task',
      title: '会产生集成冲突的任务',
      desc: '',
      priority: 'high',
      labels: [],
      status: 'todo',
      executionMode: 'auto'
    }), createConflictResponse)
    const conflictSourceId = createConflictResponse.body.item.id
    const runConflictResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${conflictSourceId}/run`), runConflictResponse)
    const conflictAgent = liveAgent
    await taskTool.execute({ outcome: 'delivery_ready', summary: '等待冲突集成' }, { agent: conflictAgent })
    conflictAgent.cancel({ kind: 'user' })
    workspaceMocks.integrate.mockResolvedValueOnce({
      kind: 'conflicted',
      sourceCommit: 'conflict-source-commit',
      reason: 'shared.txt content conflict',
      rebaseInProgress: true
    })
    const confirmConflictResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${conflictSourceId}/confirm-delivery`), confirmConflictResponse)
    expect(confirmConflictResponse.status).toBe(200)
    expect(confirmConflictResponse.body.item.archived).toBe(false)
    expect(confirmConflictResponse.body.item.integrationState).toBe('conflicted')
    expect(confirmConflictResponse.body.item.executionState).toBe('running')

    await taskTool.execute({ outcome: 'integration_resolved', summary: '保留双方功能并通过测试' }, { agent: conflictAgent })
    expect(workspaceMocks.continueIntegration).toHaveBeenCalledOnce()
    const resolvedBoardResponse = response()
    await route(request('GET', '/taskboard/boards/workspace-1/history?offset=0&limit=50'), resolvedBoardResponse)
    const resolved = resolvedBoardResponse.body.items.find(item => item.id === conflictSourceId)
    expect(resolved.archived).toBe(true)
    expect(resolved.integrationState).toBe('merged')
    expect(resolved.commitRef).toBe('resolved-commit')
    expect(resolvedBoardResponse.body.items.some(item => item.conflictOf === conflictSourceId)).toBe(false)
    await vi.waitFor(async () => {
      const cleanedHistory = response()
      await route(request('GET', '/taskboard/boards/workspace-1/history?offset=0&limit=50'), cleanedHistory)
      const cleaned = cleanedHistory.body.items.find(item => item.id === conflictSourceId)
      expect(cleaned.taskWorkspace).toBeUndefined()
    })
    const manualCleanupResponse = response()
    await route(request('POST', `/taskboard/boards/workspace-1/history/${conflictSourceId}/cleanup`), manualCleanupResponse)
    expect(manualCleanupResponse.status).toBe(200)
    expect(manualCleanupResponse.body.item.sessionId).toBe(conflictAgent.id)
    expect(archiveSession).toHaveBeenCalledTimes(2)

    const externalBlockCreate = response()
    await route(request('POST', '/taskboard/boards/workspace-1/items', {
      type: 'task', title: '集成状态重试', desc: '', priority: 'medium', labels: [], status: 'todo', executionMode: 'auto'
    }), externalBlockCreate)
    const externalBlockId = externalBlockCreate.body.item.id
    const externalBlockRun = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${externalBlockId}/run`), externalBlockRun)
    const externalAgent = liveAgent
    await taskTool.execute({ outcome: 'delivery_ready', summary: '交付完成' }, { agent: externalAgent })
    externalAgent.cancel({ kind: 'user' })
    workspaceMocks.integrate.mockResolvedValueOnce({
      kind: 'conflicted', sourceCommit: 'pending-commit', reason: '主工作区有外部改动', rebaseInProgress: false
    })
    const blockedDelivery = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${externalBlockId}/confirm-delivery`), blockedDelivery)
    expect(blockedDelivery.body.item.executionState).toBe('blocked')
    const agentCreations = create.mock.calls.length
    const retryIntegration = response()
    await route(request('POST', `/taskboard/boards/workspace-1/items/${externalBlockId}/run`), retryIntegration)
    expect(retryIntegration.status).toBe(200)
    expect(retryIntegration.body.item.integrationState).toBe('merged')
    expect(retryIntegration.body.item.archived).toBe(true)
    expect(create).toHaveBeenCalledTimes(agentCreations)
  })
})
