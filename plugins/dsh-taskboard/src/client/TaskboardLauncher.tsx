/**
 * 需求看板工作台，`shell.overlay` 单条目：左缘按钮 + 中间工作台浮层。
 * 工作台 = 项目切换 + 多列看板 + 工作项详情（需求追溯 + 会话联动）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { analyzeItem, approveItem, cleanupHistoryWorkspace, confirmDelivery, confirmPlanItem, createItem, deleteItem, fetchBoards, fetchHistory, fetchPreviewBase, forceCloseItem, rejectItem, runItem, saveSettings, updateItem, type BoardsResponse, type ItemInput } from './api.ts'
import { Board } from './Board.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ItemDetail } from './ItemDetail.tsx'
import { ItemEditor } from './ItemEditor.tsx'
import { SettingsEditor } from './SettingsEditor.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'
import type { Board as BoardModel, WorkItem } from '../shared/types.ts'
import type { AiAnalysis } from '../shared/types.ts'
import css from './TaskboardLauncher.module.css'

/** 注入面：会话联动（浏览器半 sessions 服务的 open） */
export interface TaskboardInjected {
  openSession: (sessionId: string) => void
  /** 当前打开的 DSH 会话，用于看板与会话主视图互斥。 */
  currentSessionId: () => string | undefined
  /** 订阅 DSH 会话列表及当前会话变化。 */
  subscribeSessions: (listener: () => void) => () => void
  /** 当前 DSH 会话所属工作区，用于首次打开时自动选中。 */
  currentProjectPath: () => string | undefined
}

/** 组合 props：overlay 条目 + 注入面 */
export type TaskboardLauncherProps = ComposedProps<'shell.overlay', 'taskboard', never, undefined, TaskboardInjected>

/** 编辑器席位 */
interface EditorSeat {
  item: WorkItem | null
  defaultStatus?: string | undefined
}

/** 本地保存的项目选择 */
const CURRENT_KEY = 'suhan-dsh-taskboard-current'

/**
 * Render the workspace.
 * @param props - injected openSession + composed slot props.
 */
export function TaskboardLauncher ({ openSession, currentSessionId, subscribeSessions, currentProjectPath }: TaskboardLauncherProps) {
  const [open, setOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<BoardsResponse | null>(null)
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorSeat | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<WorkItem[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null)
  const [forceCloseTarget, setForceCloseTarget] = useState<WorkItem | null>(null)
  const [deliveryTarget, setDeliveryTarget] = useState<WorkItem | null>(null)
  const [cleanupTarget, setCleanupTarget] = useState<WorkItem | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 页面预览基地址（项目 dev server）；解析失败时带原因。 */
  const [previewBase, setPreviewBase] = useState<{ baseUrl: string | null; error?: string | undefined } | null>(null)
  const [previewBasePending, setPreviewBasePending] = useState(false)

  const closeAll = useCallback((): void => {
    setOpen(false)
    setSelectedId(null)
    setEditor(null)
    setSettingsOpen(false)
    setHistoryOpen(false)
    setDeleteTarget(null)
    setForceCloseTarget(null)
    setCleanupTarget(null)
    setError(null)
    setNotice(null)
  }, [])

  /** 跟随 DSH 可拖拽/可折叠侧栏，让主看板始终只占右侧内容区。 */
  useEffect(() => {
    const shell = shellRef.current
    const frame = shell?.closest('[data-shell-overlay]')?.parentElement
    const sidebar = frame?.firstElementChild
    if (shell === null || !(sidebar instanceof HTMLElement)) return

    const newSessionButton = [...sidebar.querySelectorAll<HTMLButtonElement>('button[aria-label="新建会话"]')]
      .find(button => button.getBoundingClientRect().height > 30)
    const existingSpacer = sidebar.querySelector<HTMLElement>('[data-taskboard-launcher-spacer]')
    const spacer = existingSpacer ?? document.createElement('div')
    const ownsSpacer = existingSpacer === null
    spacer.className = css.sidebarSpacer ?? ''
    spacer.dataset.taskboardLauncherSpacer = ''
    spacer.setAttribute('aria-hidden', 'true')
    if (ownsSpacer && newSessionButton !== undefined) newSessionButton.insertAdjacentElement('afterend', spacer)

    const syncSidebar = (): void => {
      const width = sidebar.getBoundingClientRect().width
      if (width <= 0) return
      shell.style.setProperty('--taskboard-sidebar-width', `${width}px`)
      if (newSessionButton !== undefined) {
        const shellTop = shell.getBoundingClientRect().top
        const buttonBottom = newSessionButton.getBoundingClientRect().bottom
        shell.style.setProperty('--taskboard-launcher-top', `${buttonBottom - shellTop + 8}px`)
      }
      setSidebarCollapsed(width <= 60)
    }

    syncSidebar()
    const observer = new ResizeObserver(syncSidebar)
    observer.observe(sidebar)
    if (newSessionButton !== undefined) observer.observe(newSessionButton)
    return () => {
      observer.disconnect()
      if (ownsSpacer) spacer.remove()
    }
  }, [])

  /** 原生会话发生切换，或直接点击当前会话行时，退出看板回到会话主视图。 */
  useEffect(() => {
    if (!open) return
    const openedFrom = currentSessionId()
    const unsubscribe = subscribeSessions(() => {
      if (currentSessionId() !== openedFrom) closeAll()
    })
    const sidebar = shellRef.current?.closest('[data-shell-overlay]')?.parentElement?.firstElementChild
    const handleSidebarClick = (event: Event): void => {
      const target = event.target
      if (!(sidebar instanceof HTMLElement) || !(target instanceof Element)) return
      const sessionRow = target.closest('[role="treeitem"][aria-selected]')
      if (sessionRow !== null && sidebar.contains(sessionRow)) closeAll()
    }
    document.addEventListener('click', handleSidebarClick, true)
    return () => {
      unsubscribe()
      document.removeEventListener('click', handleSidebarClick, true)
    }
  }, [closeAll, currentSessionId, open, subscribeSessions])

  /** 加载全量数据；选定项目（记忆上次选择） */
  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchBoards()
      // 轮询成功不主动清除错误：操作失败的报错条保持可读，直到下次操作或手动关闭。
      setData(res)
      const keys = Object.keys(res.boards)
      const remembered = window.localStorage.getItem(CURRENT_KEY)
      const activePath = currentProjectPath()
      const activeKey = activePath === undefined
        ? undefined
        : keys.find(candidate => {
          const candidateBoard = res.boards[candidate]
          return candidateBoard?.projectPath === activePath || candidateBoard?.items.some(item => item.taskWorkspace?.path === activePath) === true
        })
      const fallback = activeKey ?? (remembered !== null && keys.includes(remembered) ? remembered : keys[0]) ?? null
      setCurrentKey(prev => prev !== null && keys.includes(prev) ? prev : fallback)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [currentProjectPath])

  useEffect(() => {
    if (!open) return
    load()
    const timer = window.setInterval(() => { load() }, 3000)
    return () => window.clearInterval(timer)
  }, [open, load])

  const board: BoardModel | null = data !== null && currentKey !== null
    ? (data.boards[currentKey] ?? null)
    : null

  /** 当前选中工作项（从最新数据派生，保证详情即时） */
  const selected: WorkItem | null = useMemo(() => {
    if (selectedId === null || board === null) return null
    return board.items.find(i => i.id === selectedId && !i.archived) ?? null
  }, [selectedId, board])

  /** 改动预览页地址：任务 worktree 存在（执行中/待交付）或已有集成提交（已完成/旧流程已提交）时提供。 */
  const previewUrl: string | undefined = selected !== null && board !== null &&
    (selected.taskWorkspace !== undefined || selected.commitRef !== undefined)
    ? `/taskboard/boards/${encodeURIComponent(board.projectKey)}/items/${encodeURIComponent(selected.id)}/preview`
    : undefined

  /** 选中任务时解析页面预览基地址（项目 dev server），相对路径拼成完整可打开地址。 */
  useEffect(() => {
    if (currentKey === null || selected === null || (selected.previewUrls ?? []).length === 0) {
      setPreviewBase(null)
      setPreviewBasePending(false)
      return
    }
    let cancelled = false
    setPreviewBasePending(true)
    void fetchPreviewBase(currentKey).then(result => {
      if (!cancelled) { setPreviewBase(result); setPreviewBasePending(false) }
    }).catch(err => {
      if (!cancelled) {
        setPreviewBase({ baseUrl: null, error: err instanceof Error ? err.message : String(err) })
        setPreviewBasePending(false)
      }
    })
    return () => { cancelled = true }
  }, [currentKey, selected])

  /**
   * 解析后的页面预览完整地址：相对路径 → dev server 基地址 + 路径；已是 http(s) 原样保留。
   * 基地址尚未解析出来（启动中）或解析失败时不产出相对路径链接——
   * 否则 href 按当前宿主 origin（3080）解析，落到宿主页面而非改动项目。
   */
  const resolvedPreviewUrls: string[] = (selected?.previewUrls ?? [])
    .filter(url => /^https?:\/\//.test(url) || (previewBase !== null && previewBase.baseUrl !== null))
    .map(url => /^https?:\/\//.test(url) ? url : `${previewBase?.baseUrl ?? ''}${url}`)

  /** 局部更新：看板里某项不存在则追加（新建），存在则替换（更新/流转/执行） */
  const patchBoardItem = useCallback((key: string, updated: WorkItem): void => {
    setData(prev => {
      if (prev === null) return prev
      const target = prev.boards[key]
      if (target === undefined) return prev
      const exists = target.items.some(i => i.id === updated.id)
      return {
        ...prev,
        boards: {
          ...prev.boards,
          [key]: {
            ...target,
            items: exists
              ? target.items.map(i => i.id === updated.id ? updated : i)
              : [...target.items, updated],
            updatedAt: updated.updatedAt
          }
        }
      }
    })
  }, [])

  const handleSelectProject = (key: string): void => {
    setCurrentKey(key)
    setSelectedId(null)
    setHistoryOpen(false)
    setHistoryItems([])
    setHistoryTotal(0)
    window.localStorage.setItem(CURRENT_KEY, key)
  }

  const loadHistory = async (append: boolean): Promise<void> => {
    if (currentKey === null || historyLoading) return
    setHistoryLoading(true)
    try {
      const offset = append ? historyItems.length : 0
      const result = await fetchHistory(currentKey, offset)
      setHistoryItems(previous => append ? [...previous, ...result.items] : result.items)
      setHistoryTotal(result.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setHistoryLoading(false)
    }
  }

  const toggleHistory = (): void => {
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
    void loadHistory(false)
  }

  const handleSaveItem = async (input: ItemInput): Promise<void> => {
    if (board === null || currentKey === null) return
    try {
      const editingItem = editor?.item ?? null
      const creating = editingItem === null
      const updated = creating
        ? await createItem(currentKey, input)
        : await updateItem(currentKey, editingItem.id, input)
      patchBoardItem(currentKey, updated)
      setSelectedId(updated.id)
      setEditor(null)
      setError(null)
      // AI 创建流程：草稿创建后立即启动 AI 分析；失败仅留草稿（可稍后重试）。
      if (creating && (input.originalRequirement ?? '').trim() !== '') {
        try {
          const analyzed = await analyzeItem(currentKey, updated.id)
          patchBoardItem(currentKey, analyzed)
        } catch (analyzeErr) {
          setError(`草稿已创建，但 方案生成启动失败：${analyzeErr instanceof Error ? analyzeErr.message : String(analyzeErr)}（可打开详情重试分析）`)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** AI 创建流程：启动/重新启动分析（supplement 追加为补充需求）。 */
  const handleAnalyze = async (supplement?: string): Promise<void> => {
    if (board === null || currentKey === null || selected === null) return
    setRunning(true)
    try {
      const updated = await analyzeItem(currentKey, selected.id, supplement)
      patchBoardItem(currentKey, updated)
      setError(null)
      setNotice(supplement === undefined || supplement.trim() === ''
        ? '方案生成已启动，完成后将进入方案确认'
        : '补充需求已追加，正在重新分析')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  /** AI 创建流程：确认并冻结方案（服务端自动开始执行）。 */
  const handleConfirmPlan = async (input: { title?: string; analysis: AiAnalysis }): Promise<void> => {
    if (board === null || currentKey === null || selected === null) return
    setRunning(true)
    try {
      const updated = await confirmPlanItem(currentKey, selected.id, input)
      patchBoardItem(currentKey, updated)
      setError(null)
      setNotice('方案已冻结为执行依据，AI 已开始开发')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleHistoryCleanup = async (): Promise<void> => {
    if (currentKey === null || cleanupTarget === null || running) return
    setRunning(true)
    try {
      const updated = await cleanupHistoryWorkspace(currentKey, cleanupTarget.id)
      setHistoryItems(previous => previous.map(item => item.id === updated.id ? updated : item))
      setCleanupTarget(null)
      setError(null)
      setNotice('临时 Workspace、worktree 和任务分支已清理；聊天记录仍可从历史任务打开')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleMove = async (itemId: string, status: string): Promise<void> => {
    if (board === null || currentKey === null) return
    try {
      const updated = await updateItem(currentKey, itemId, { status })
      patchBoardItem(currentKey, updated)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (running || board === null || currentKey === null || deleteTarget === null) return
    setRunning(true)
    try {
      const result = await deleteItem(currentKey, deleteTarget.id)
      setData(prev => {
        if (prev === null) return prev
        const target = prev.boards[currentKey]
        if (target === undefined) return prev
        return {
          ...prev,
          boards: {
            ...prev.boards,
            [currentKey]: { ...target, items: target.items.filter(i => i.id !== deleteTarget.id) }
          }
        }
      })
      setDeleteTarget(null)
      setSelectedId(null)
      setError(null)
      setNotice(result.warning ?? (result.rolledBack
        ? '任务已停止，执行产生的改动已回退；会话已归档，卡片已删除'
        : '卡片已删除'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleForceClose = async (): Promise<void> => {
    if (running || board === null || currentKey === null || forceCloseTarget === null) return
    setRunning(true)
    try {
      await forceCloseItem(currentKey, forceCloseTarget.id)
      setData(prev => {
        if (prev === null) return prev
        const target = prev.boards[currentKey]
        if (target === undefined) return prev
        return {
          ...prev,
          boards: {
            ...prev.boards,
            [currentKey]: { ...target, items: target.items.filter(i => i.id !== forceCloseTarget.id) }
          }
        }
      })
      setForceCloseTarget(null)
      setSelectedId(null)
      setError(null)
      setNotice('任务已强制关闭；Agent 已停止，工作区改动已回退，会话和卡片已归档')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleRun = async (): Promise<void> => {
    if (board === null || currentKey === null || selected === null) return
    setRunning(true)
    try {
      const updated = await runItem(currentKey, selected.id)
      setError(null)
      setNotice(`已下发到会话：${updated.sessionId ?? ''}（可随时打开查看）`)
      patchBoardItem(currentKey, updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleExecutionAction = async (action: 'approve' | 'reject' | 'confirm-delivery'): Promise<void> => {
    if (currentKey === null || selected === null) return
    setRunning(true)
    try {
      const updated = action === 'approve'
        ? await approveItem(currentKey, selected.id)
        : action === 'reject'
          ? await rejectItem(currentKey, selected.id)
          : await confirmDelivery(currentKey, selected.id)
      patchBoardItem(currentKey, updated)
      setDeliveryTarget(null)
      setError(null)
      setNotice(action === 'approve'
        ? '已批准，Agent 将在原会话继续下一环节'
        : action === 'reject'
          ? '已退回，Agent 将在原会话修订当前环节'
          : updated.integrationState === 'conflicted'
            ? '变基发生冲突，系统已在原任务会话中自主处理'
            : '任务已自动提交并集成，可在历史任务中查看')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleSaveSettings = async (settings: { columns: BoardModel['columns']; itemTypes: BoardModel['itemTypes'] }): Promise<void> => {
    if (board === null || currentKey === null) return
    try {
      const updatedBoard = await saveSettings(currentKey, settings)
      setData(prev => prev === null
        ? prev
        : { ...prev, boards: { ...prev.boards, [currentKey]: updatedBoard } })
      setSettingsOpen(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      ref={shellRef}
      className={css.shell}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
    >
      <button
        type='button'
        className={`${css.launcher} ${open ? css.launcherActive : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label='需求看板'
        aria-expanded={open}
        data-testid='taskboard-launcher'
      >
        <span className={css.launcherIcon} aria-hidden='true'>▦</span>
        <span className={css.launcherText}>看板</span>
      </button>

      {open && (
        <main className={css.workspace} aria-label='需求看板工作台' data-testid='taskboard-workspace'>
          <header className={css.modalHead}>
            <div className={css.headLeft}>
              <h2 className={css.modalTitle}>需求看板</h2>
              <span className={css.modalHint}>项目级需求追溯 · 工作项可下发到聊天会话执行</span>
            </div>
            <div className={css.headRight}>
              {data !== null && data.workspaces.length > 0 && (
                <select
                  className={css.projectSelect}
                  value={currentKey ?? ''}
                  onChange={ev => handleSelectProject(ev.target.value)}
                  aria-label='切换项目'
                  data-testid='taskboard-project-select'
                >
                  {data.workspaces.map(w => (
                    <option key={w.id} value={w.id}>{w.title}</option>
                  ))}
                </select>
              )}
              {board !== null && (
                <>
                  <button type='button' className={`${css.headBtn} ${css.headBtnCreate}`} onClick={() => setEditor({ item: null, defaultStatus: board.columns[0]?.id })}>＋ 新建工作项</button>
                  <button
                    type='button'
                    className={css.headBtn}
                    onClick={toggleHistory}
                    aria-expanded={historyOpen}
                    aria-controls='taskboard-history-panel'
                  >
                    {historyOpen ? '返回看板' : '历史任务'}
                  </button>
                  <button type='button' className={css.headBtn} onClick={() => setSettingsOpen(true)}>看板设置</button>
                </>
              )}
              <button type='button' className={css.closeBtn} onClick={closeAll} aria-label='关闭看板' data-testid='taskboard-close-btn'>✕</button>
            </div>
          </header>

          {error !== null && (
            <div className={css.error} role='alert'>
              <span>{error}</span>
              <button type='button' className={css.errorDismiss} onClick={() => setError(null)} aria-label='关闭错误提示'>✕</button>
            </div>
          )}
          {notice !== null && <div className={css.notice} role='status'>{notice}</div>}

          <div className={css.modalBody}>
            {board === null
              ? (
                <div className={css.empty}>
                  <p>当前没有已注册的 DSH 工作区，请先在会话侧选择或创建工作区。</p>
                </div>
                )
              : historyOpen
                ? (
                  <HistoryPanel
                    projectTitle={board.projectTitle}
                    items={historyItems}
                    total={historyTotal}
                    loading={historyLoading}
                    onLoadMore={() => { void loadHistory(true) }}
                    onOpenSession={sessionId => {
                      closeAll()
                      openSession(sessionId)
                    }}
                    onCleanup={item => setCleanupTarget(item)}
                    onClose={() => setHistoryOpen(false)}
                  />
                  )
              : (
                <div className={css.boardWrap}>
                  <Board
                    board={board}
                    onMove={(id, status) => handleMove(id, status)}
                    onSelect={item => setSelectedId(item.id)}
                  />
                  {selected !== null && (
                    <ItemDetail
                      item={selected}
                      board={board}
                      typeDef={board.itemTypes.find(t => t.key === selected.type)}
                      parentTitle={selected.parentId === undefined ? undefined : board.items.find(i => i.id === selected.parentId)?.title}
                      busy={running}
                      previewUrl={previewUrl}
                      pagePreviewUrls={resolvedPreviewUrls}
                      previewBasePending={previewBasePending}
                      previewBaseError={previewBase?.error}
                      onClose={() => setSelectedId(null)}
                      onEdit={() => setEditor({ item: selected })}
                      onDelete={() => setDeleteTarget(selected)}
                      onRun={() => handleRun()}
                      onApprove={() => handleExecutionAction('approve')}
                      onReject={() => handleExecutionAction('reject')}
                      onConfirmDelivery={() => setDeliveryTarget(selected)}
                      onForceClose={() => setForceCloseTarget(selected)}
                      onOpenSession={sessionId => {
                        closeAll()
                        openSession(sessionId)
                      }}
                      onAnalyze={supplement => { void handleAnalyze(supplement) }}
                      onConfirmPlan={input => { void handleConfirmPlan(input) }}
                    />
                  )}
                </div>
                )}
          </div>
        </main>
      )}

      {editor !== null && board !== null && (
        <ItemEditor
          item={editor.item}
          board={board}
          defaultStatus={editor.defaultStatus}
          onCancel={() => setEditor(null)}
          onSave={input => handleSaveItem(input)}
        />
      )}

      {settingsOpen && board !== null && (
        <SettingsEditor
          board={board}
          onCancel={() => setSettingsOpen(false)}
          onSave={settings => handleSaveSettings(settings)}
        />
      )}

      {deleteTarget !== null && (
        <ConfirmDialog
          title='删除工作项'
          message={deleteTarget.sessionId === undefined
            ? `确定删除「${deleteTarget.title}」吗？卡片将从看板移除。`
            : deleteTarget.taskWorkspace !== undefined
              ? `确定删除「${deleteTarget.title}」吗？系统会停止 Agent 并删除该任务的独立 worktree/分支，不会影响其他并行任务。`
              : deleteTarget.gitCheckpoint === undefined
              ? `确定删除「${deleteTarget.title}」吗？这是没有回退基线的旧任务：系统会停止 Agent、归档会话并删除卡片，但无法自动撤销旧任务已经产生的文件改动。`
              : `确定删除「${deleteTarget.title}」吗？系统会立即停止 Agent，把工作区和暂存区恢复到任务首次执行前，再归档会话并删除卡片。`}
          confirmLabel={running ? '处理中…' : '删除'}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete()}
        />
      )}

      {deliveryTarget !== null && (
        <ConfirmDialog
          title='确认最终交付'
          message={`确认「${deliveryTarget.title}」的交付物符合要求吗？确认后看板会自动提交独立 worktree，通过变基串行集成到目标分支；若发生代码冲突，系统会在原任务会话中自主取舍并继续集成。`}
          confirmLabel='确认并提交'
          onCancel={() => setDeliveryTarget(null)}
          onConfirm={() => handleExecutionAction('confirm-delivery')}
        />
      )}

      {forceCloseTarget !== null && (
        <ConfirmDialog
          title='强制关闭任务并回退'
          message={`确定强制关闭「${forceCloseTarget.title}」吗？系统会立即停止 Agent 并删除该任务的独立 worktree/分支，不会修改其他任务或项目主工作区。成功后会话和卡片会归档。`}
          confirmLabel={running ? '处理中…' : '强制关闭并回退'}
          onCancel={() => setForceCloseTarget(null)}
          onConfirm={() => handleForceClose()}
        />
      )}

      {cleanupTarget !== null && (
        <ConfirmDialog
          title='清理临时工作区'
          message={`确定清理「${cleanupTarget.title}」的临时 Workspace、worktree 和任务分支吗？任务已经集成，聊天记录与历史记录会继续保留并可打开。`}
          confirmLabel={running ? '清理中…' : '清理工作区'}
          onCancel={() => setCleanupTarget(null)}
          onConfirm={() => handleHistoryCleanup()}
        />
      )}
    </div>
  )
}
