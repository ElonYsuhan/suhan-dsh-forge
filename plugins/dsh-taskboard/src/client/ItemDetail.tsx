/**
 * 工作项详情面板：完整字段 + 需求追溯时间线 + 会话联动（执行 / 打开会话）。
 */
import { executionModeOf, executionStateOf, type Board, type ItemTypeDef, type WorkItem } from '../shared/types.ts'
import css from './ItemDetail.module.css'

/** Detail panel surface props. */
export interface ItemDetailProps {
  item: WorkItem
  board: Board
  typeDef?: ItemTypeDef | undefined
  parentTitle?: string | undefined
  /** 正在提交某个操作 */
  busy: boolean
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
  onApprove: () => void
  onReject: () => void
  onConfirmDelivery: () => void
  onForceClose: () => void
  onOpenSession: (sessionId: string) => void
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

/**
 * Render the work-item detail dialog.
 * @param props - the item, its board, and action callbacks.
 */
export function ItemDetail ({ item, board, typeDef, parentTitle, busy, onClose, onEdit, onDelete, onRun, onApprove, onReject, onConfirmDelivery, onForceClose, onOpenSession }: ItemDetailProps) {
  const statusLabel = board.columns.find(c => c.id === item.status)?.label ?? item.status
  const parentItem = item.parentId === undefined ? undefined : board.items.find(i => i.id === item.parentId)
  const executionMode = executionModeOf(item)
  const executionState = executionStateOf(item)
  const active = executionState === 'running' || executionState === 'awaiting-review' || executionState === 'awaiting-delivery' || executionState === 'committing'

  return (
    <div className={css.mask} onClick={onClose}>
      <aside
        className={css.detail}
        role='dialog'
        aria-modal='true'
        aria-label='工作项详情'
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
            </div>
          )}

          <div className={css.actions}>
            {!active && (
              <button type='button' className={css.runBtn} onClick={onRun} disabled={busy} data-testid='taskboard-run-btn'>
                {busy ? '处理中…' : (item.sessionId === undefined ? '▶ 执行' : '▶ 继续执行')}
              </button>
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
            <button type='button' className={css.ghostBtn} onClick={onEdit} disabled={active || busy}>编辑</button>
            <button type='button' className={css.dangerBtn} onClick={onDelete} disabled={busy} data-testid='taskboard-delete-btn'>删除</button>
            {item.sessionId !== undefined && item.gitCheckpoint !== undefined && (
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
    </div>
  )
}
