/**
 * 工作项详情面板：完整字段 + 需求追溯时间线 + 会话联动（执行 / 打开会话）。
 * AI 创建流程（有 originalRequirement）额外展示「AI 方案」面板：
 * 草稿 → 任务方案生成按钮；分析中 → 进行中提示 + 重试；方案待确认 → 分字段编辑 +
 * 补充需求重新分析 / 确认并执行；已确认及之后 → 只读冻结方案。
 */
import { useState } from 'react'
import { creationStateOf, executionModeOf, executionStateOf, isAiFlowItem, type AiAnalysis, type Board, type CreationState, type ItemTypeDef, type WorkItem } from '../shared/types.ts'
import css from './ItemDetail.module.css'
import { MarkdownView } from './MarkdownView.tsx'
import { useDialogFocus } from './useDialogFocus.ts'

/** Detail panel surface props. */
export interface ItemDetailProps {
  item: WorkItem
  board: Board
  typeDef?: ItemTypeDef | undefined
  parentTitle?: string | undefined
  /** 正在提交某个操作 */
  busy: boolean
  /** 改动预览页地址（任务 worktree 或已集成提交存在时提供） */
  previewUrl?: string | undefined
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
  onApprove: () => void
  onReject: () => void
  onConfirmDelivery: () => void
  onForceClose: () => void
  onOpenSession: (sessionId: string) => void
  /** AI 创建流程：启动/重新启动方案生成（supplement 为补充需求） */
  onAnalyze: (supplement?: string) => void
  /** AI 创建流程：确认并冻结方案（自动开始执行） */
  onConfirmPlan: (input: { title?: string; analysis: AiAnalysis }) => void
}

/** 动作文案 */
const ACTION_LABEL: Record<string, string> = {
  created: '创建',
  moved: '流转',
  edited: '编辑',
  run: '执行',
  note: '备注'
}

const STATE_LABEL: Record<string, string> = {
  idle: '未执行',
  running: 'AI 执行中',
  'awaiting-review': '等待环节审核',
  blocked: '执行阻塞',
  'awaiting-delivery': '等待确认交付',
  committing: '正在检查并提交代码',
  failed: '执行失败'
}

/** 格式化时间（本地） */
function formatTime (iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** 行 → 非空数组（每行一项的文本域回填） */
function splitLines (value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Render the work-item detail dialog.
 * @param props - the item, its board, and action callbacks.
 */
export function ItemDetail ({ item, board, typeDef, parentTitle, busy, previewUrl, onClose, onEdit, onDelete, onRun, onApprove, onReject, onConfirmDelivery, onForceClose, onOpenSession, onAnalyze, onConfirmPlan }: ItemDetailProps) {
  const detailRef = useDialogFocus<HTMLElement>(onClose)
  const [planOpen, setPlanOpen] = useState(false)
  const statusLabel = board.columns.find(c => c.id === item.status)?.label ?? item.status
  const parentItem = item.parentId === undefined ? undefined : board.items.find(i => i.id === item.parentId)
  const executionMode = executionModeOf(item)
  const executionState = executionStateOf(item)
  const creationState = creationStateOf(item)
  // AI 创建流程：方案确认前不能执行、不能改业务字段（PlanPanel 接管编辑）。
  const preConfirm = creationState === 'draft' || creationState === 'analyzing' || creationState === 'pending_confirm'
  const active = executionState === 'running' || executionState === 'awaiting-review' || executionState === 'awaiting-delivery' || executionState === 'committing'

  return (
    <div className={css.mask} onClick={onClose}>
      <aside
        className={css.detail}
        ref={detailRef}
        role='dialog'
        aria-modal='true'
        aria-label='工作项详情'
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
      >
        <div className={css.summary}>
          <header className={css.head}>
            <div className={css.headMain}>
              <span className={css.typeBadge} style={{ color: typeDef?.color, borderColor: typeDef?.color }}>
                {typeDef?.label ?? item.type}
              </span>
              <h3 className={css.title}>{item.title}</h3>
            </div>
            <button type='button' className={css.closeBtn} onClick={onClose} aria-label='关闭详情'>✕</button>
          </header>

          <dl className={css.fields}>
            <div className={css.fieldRow}><dt>环节</dt><dd>{statusLabel}</dd></div>
            <div className={css.fieldRow}><dt>执行方式</dt><dd>{executionMode === 'review' ? '重大任务 · 逐环节审核' : '小任务 · AI 自主推进'}</dd></div>
            <div className={css.fieldRow}><dt>执行状态</dt><dd>{STATE_LABEL[executionState] ?? executionState}</dd></div>
            <div className={css.fieldRow}><dt>优先级</dt><dd>{item.priority}</dd></div>
            {item.iteration !== undefined && item.iteration !== '' && <div className={css.fieldRow}><dt>迭代</dt><dd>{item.iteration}</dd></div>}
            {parentItem !== undefined && (
              <div className={css.fieldRow}><dt>追溯父级</dt><dd>{parentTitle ?? parentItem.title}</dd></div>
            )}
            {item.labels.length > 0 && (
              <div className={css.fieldRow}><dt>标签</dt><dd>{item.labels.join('、')}</dd></div>
            )}
            {item.sessionId !== undefined && (
              <div className={css.fieldRow}><dt>会话</dt><dd className={css.mono}>{item.sessionId}</dd></div>
            )}
          </dl>

          {item.desc !== '' && <p className={css.desc}>{item.desc}</p>}

          {isAiFlowItem(item) && (
            <PlanPanel
              item={item}
              creationState={creationState ?? 'draft'}
              busy={busy}
              onAnalyze={onAnalyze}
              onConfirmPlan={onConfirmPlan}
              onViewPlan={() => setPlanOpen(true)}
            />
          )}

          {executionState === 'awaiting-review' && (
            <div className={css.reviewBox}>
              <strong>当前环节等待审核</strong>
              <p>{item.reviewSummary ?? '请打开会话检查本环节完整输出。'}</p>
            </div>
          )}
          {executionState === 'awaiting-delivery' && (
            <div className={css.deliveryBox}>
              <strong>交付物等待最终确认</strong>
              <p>{item.deliverySummary ?? '请打开会话检查交付物和质量检查结果。'}</p>
              {(item.previewUrls ?? []).length > 0 && (
                <p className={css.previewUrls} data-testid='taskboard-page-preview'>
                  {item.previewUrls!.map(url => (
                    <a key={url} className={css.pagePreviewLink} href={url} target='_blank' rel='noreferrer'>
                      🌐 页面预览：{url}
                    </a>
                  ))}
                  <span className={css.previewHint}>（代码合并后生效）</span>
                </p>
              )}
              {previewUrl !== undefined && (
                <p>
                  <a className={css.previewLink} href={previewUrl} target='_blank' rel='noreferrer' data-testid='taskboard-preview-link'>
                    🔍 预览改动（检查这个任务改了什么）
                  </a>
                </p>
              )}
            </div>
          )}

          <div className={css.actions}>
            {!active && !preConfirm && creationState !== 'completed' && (
              <button type='button' className={css.runBtn} onClick={onRun} disabled={busy} data-testid='taskboard-run-btn'>
                {busy ? '处理中…' : (item.sessionId === undefined ? '▶ 执行' : '▶ 继续执行')}
              </button>
            )}
            {previewUrl !== undefined && (
              <a className={css.ghostBtn} href={previewUrl} target='_blank' rel='noreferrer'>
                🔍 预览改动
              </a>
            )}
            {executionState === 'awaiting-review' && (
              <>
                <button type='button' className={css.approveBtn} onClick={onApprove} disabled={busy}>✓ 批准并继续</button>
                <button type='button' className={css.rejectBtn} onClick={onReject} disabled={busy}>↩ 退回修订</button>
              </>
            )}
            {executionState === 'awaiting-delivery' && (
              <button type='button' className={css.approveBtn} onClick={onConfirmDelivery} disabled={busy}>✓ 确认交付并提交</button>
            )}
            {item.sessionId !== undefined && (
              <button type='button' className={css.sessionBtn} onClick={() => onOpenSession(item.sessionId as string)}>
                打开会话
              </button>
            )}
            {!preConfirm && (
              <button type='button' className={css.ghostBtn} onClick={onEdit} disabled={active || busy}>编辑</button>
            )}
            <button type='button' className={css.dangerBtn} onClick={onDelete} disabled={busy} data-testid='taskboard-delete-btn'>删除</button>
            {(item.taskWorkspace !== undefined || item.gitCheckpoint !== undefined) && (
              <button type='button' className={css.forceCloseBtn} onClick={onForceClose} disabled={busy} data-testid='taskboard-force-close-btn'>强制关闭</button>
            )}
          </div>
        </div>

        <section className={css.timeline} aria-label='需求追溯'>
          <h4 className={css.timelineTitle}>需求追溯</h4>
          <ol className={css.timelineList}>
            {[...item.timeline].reverse().map((entry, idx) => (
              <li key={`${entry.at}-${idx}`} className={css.timelineEntry}>
                <span className={`${css.timelineDot} ${css['action-' + entry.action]}`} aria-hidden='true' />
                <div className={css.timelineBody}>
                  <div className={css.timelineHead}>
                    <span className={css.timelineAction}>{ACTION_LABEL[entry.action] ?? entry.action}</span>
                    <span className={css.timelineTime}>{formatTime(entry.at)}</span>
                  </div>
                  {entry.action === 'moved' && (
                    <div className={css.timelineNote}>
                      {board.columns.find(c => c.id === entry.from)?.label ?? entry.from} → {board.columns.find(c => c.id === entry.to)?.label ?? entry.to}
                    </div>
                  )}
                  {entry.note !== undefined && entry.note !== '' && <div className={css.timelineNote}>{entry.note}</div>}
                  {entry.sessionId !== undefined && (
                    <button type='button' className={css.timelineSession} onClick={() => onOpenSession(entry.sessionId as string)}>
                      查看会话
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </aside>

      {planOpen && item.frozenPlan !== undefined && (
        <div className={css.mask} onClick={() => setPlanOpen(false)}>
          <div
            className={css.planModal}
            role='dialog'
            aria-modal='true'
            aria-label='冻结方案'
            onClick={event => event.stopPropagation()}
          >
            <header className={css.planModalHead}>
              <h3 className={css.planModalTitle}>冻结方案 · {item.title}</h3>
              <button type='button' className={css.closeBtn} onClick={() => setPlanOpen(false)} aria-label='关闭方案'>✕</button>
            </header>
            <div className={css.planFrozen}>
              <MarkdownView text={item.frozenPlan} className={css.markdown} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** AI 创建流程方案面板：按创建状态切换内容。 */
function PlanPanel ({ item, creationState, busy, onAnalyze, onConfirmPlan, onViewPlan }: {
  item: WorkItem
  creationState: CreationState
  busy: boolean
  onAnalyze: (supplement?: string) => void
  onConfirmPlan: (input: { title?: string; analysis: AiAnalysis }) => void
  onViewPlan: () => void
}) {
  if (creationState === 'draft') {
    return (
      <section className={css.planPanel}>
        <h4 className={css.planTitle}>AI 方案</h4>
        <p className={css.planHint}>将结合当前项目代码分析这个想法，生成需求理解 / 现状分析 / 实施方案 / 验收标准。</p>
        <div className={css.planActions}>
          <button type='button' className={css.planConfirmBtn} onClick={() => onAnalyze()} disabled={busy} data-testid='taskboard-plan-analyze'>
            任务方案生成
          </button>
        </div>
      </section>
    )
  }
  if (creationState === 'analyzing') {
    return (
      <section className={css.planPanel}>
        <h4 className={css.planTitle}>AI 方案</h4>
        <p className={css.planHint}>AI 正在读取项目代码并生成方案…（通常需要几分钟，请稍候）</p>
        <div className={css.planActions}>
          <button type='button' className={css.ghostBtn} onClick={() => onAnalyze()} disabled={busy}>↻ 重试方案生成</button>
        </div>
      </section>
    )
  }
  if (creationState === 'pending_confirm') {
    return <PlanConfirmEditor item={item} busy={busy} onAnalyze={onAnalyze} onConfirmPlan={onConfirmPlan} />
  }
  // confirmed / executing / completed：冻结方案入口（点击查看完整方案）。
  return (
    <section className={css.planPanel}>
      <h4 className={css.planTitle}>冻结方案（执行唯一依据）</h4>
      <p className={css.planHint}>方案确认后已冻结，开发执行严格按此方案进行。</p>
      <div className={css.planActions}>
        <button type='button' className={css.planConfirmBtn} onClick={onViewPlan} data-testid='taskboard-plan-view'>
          📋 查看方案
        </button>
      </div>
    </section>
  )
}

/**
 * 方案待确认的分字段编辑器：每次进入本状态时全新挂载，
 * 轮询刷新不会覆盖用户正在编辑的缓冲；重新生成方案后回到本状态即重建。
 * 文本字段采用 Markdown 编辑 / 预览双模，列表字段预览自动转列表。
 */
function PlanConfirmEditor ({ item, busy, onAnalyze, onConfirmPlan }: {
  item: WorkItem
  busy: boolean
  onAnalyze: (supplement?: string) => void
  onConfirmPlan: (input: { title?: string; analysis: AiAnalysis }) => void
}) {
  const analysis = item.aiAnalysis
  const [title, setTitle] = useState(analysis?.suggestedTitle ?? item.title)
  const [requirementUnderstanding, setRequirementUnderstanding] = useState(analysis?.requirementUnderstanding ?? '')
  const [projectAnalysis, setProjectAnalysis] = useState(analysis?.projectAnalysis ?? '')
  const [implementationPlan, setImplementationPlan] = useState(analysis?.implementationPlan.join('\n') ?? '')
  const [affectedModules, setAffectedModules] = useState(analysis?.affectedModules.join('\n') ?? '')
  const [pendingQuestions, setPendingQuestions] = useState(analysis?.pendingQuestions.join('\n') ?? '')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(analysis?.acceptanceCriteria.join('\n') ?? '')
  const [supplement, setSupplement] = useState('')

  const handleConfirm = (): void => {
    if (analysis === undefined) return
    onConfirmPlan({
      title: title.trim(),
      analysis: {
        ...analysis,
        suggestedTitle: title.trim(),
        requirementUnderstanding: requirementUnderstanding.trim(),
        projectAnalysis: projectAnalysis.trim(),
        implementationPlan: splitLines(implementationPlan),
        affectedModules: splitLines(affectedModules),
        pendingQuestions: splitLines(pendingQuestions),
        acceptanceCriteria: splitLines(acceptanceCriteria)
      }
    })
  }

  if (analysis === undefined) {
    return (
      <section className={css.planPanel}>
        <h4 className={css.planTitle}>AI 方案</h4>
        <p className={css.planHint}>方案尚未生成，请稍候或重试方案生成。</p>
        <div className={css.planActions}>
          <button type='button' className={css.ghostBtn} onClick={() => onAnalyze()} disabled={busy}>↻ 重试方案生成</button>
        </div>
      </section>
    )
  }

  return (
    <section className={css.planPanel} data-testid='taskboard-plan-editor'>
      <h4 className={css.planTitle}>AI 方案（待确认）</h4>
      <label className={css.planField}>
        <span className={css.planLabel}>标题（AI 建议，可修改）</span>
        <input className={css.planInput} value={title} onChange={ev => setTitle(ev.target.value)} data-testid='taskboard-plan-title' />
      </label>
      <MdField label='需求理解' value={requirementUnderstanding} onChange={setRequirementUnderstanding} rows={3} />
      <MdField label='项目现状分析' value={projectAnalysis} onChange={setProjectAnalysis} rows={4} />
      <MdField label='实施方案（每行一步，支持 Markdown）' value={implementationPlan} onChange={setImplementationPlan} rows={5} list />
      <MdField label='影响范围（每行一项）' value={affectedModules} onChange={setAffectedModules} rows={3} list />
      <MdField label='待确认项（每行一项）' value={pendingQuestions} onChange={setPendingQuestions} rows={3} list />
      <MdField label='验收标准（每行一项）' value={acceptanceCriteria} onChange={setAcceptanceCriteria} rows={4} list />
      <label className={css.planField}>
        <span className={css.planLabel}>补充需求（可选，将追加进原始需求并重新生成方案）</span>
        <textarea className={css.planTextarea} rows={2} value={supplement} onChange={ev => setSupplement(ev.target.value)} placeholder='例如：还要支持手机号登录' data-testid='taskboard-plan-supplement' />
      </label>
      <div className={css.planActions}>
        <button type='button' className={css.ghostBtn} onClick={() => onAnalyze(supplement.trim() === '' ? undefined : supplement.trim())} disabled={busy}>
          ↻ 重新生成方案
        </button>
        <button type='button' className={css.planConfirmBtn} onClick={handleConfirm} disabled={busy} data-testid='taskboard-plan-confirm'>
          ✓ 确认并执行
        </button>
      </div>
    </section>
  )
}

/** 每行一项 → 预览用 markdown 列表（已有列表标记的行原样保留）。 */
function toListMarkdown (value: string): string {
  return value.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => /^[-*] |^\d+[.)] /.test(line) ? line : `- ${line}`)
    .join('\n')
}

/** 单个方案字段：编辑 / 预览双模（默认预览，点击「编辑」切换 textarea）。 */
function MdField ({ label, value, onChange, rows, list }: {
  label: string
  value: string
  onChange: (value: string) => void
  rows: number
  list?: boolean | undefined
}) {
  const [editing, setEditing] = useState(false)
  return (
    <div className={css.planField}>
      <div className={css.planFieldHead}>
        <span className={css.planLabel}>{label}</span>
        <span className={css.planModeSwitch} role='group' aria-label={`${label}：编辑或预览`}>
          <button
            type='button'
            className={editing ? css.planModeOn : undefined}
            onClick={() => setEditing(true)}
            aria-pressed={editing}
          >
            编辑
          </button>
          <button
            type='button'
            className={editing ? undefined : css.planModeOn}
            onClick={() => setEditing(false)}
            aria-pressed={!editing}
          >
            预览
          </button>
        </span>
      </div>
      {editing
        ? <textarea className={css.planTextarea} rows={rows} value={value} onChange={ev => onChange(ev.target.value)} />
        : (
          <div className={css.planPreview}>
            <MarkdownView text={list === true ? toListMarkdown(value) : value} className={css.markdown} />
          </div>
        )}
    </div>
  )
}
