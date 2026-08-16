/** 当前工作区的历史工作项列表。 */
import type { WorkItem } from '../shared/types.ts'
import css from './HistoryPanel.module.css'

export interface HistoryPanelProps {
  projectTitle: string
  items: WorkItem[]
  total: number
  loading: boolean
  onLoadMore: () => void
  onOpenSession: (sessionId: string) => void
  onCleanup: (item: WorkItem) => void
  onClose: () => void
}

function outcome (item: WorkItem): string {
  if (item.integrationState === 'merged') return '已集成'
  if (item.integrationState === 'conflicted') return '集成冲突'
  if (item.commitRef !== undefined) return '已提交'
  return item.executionState === 'failed' ? '失败归档' : '已归档'
}

export function HistoryPanel ({ projectTitle, items, total, loading, onLoadMore, onOpenSession, onCleanup, onClose }: HistoryPanelProps) {
  return (
    <section
      id='taskboard-history-panel'
      className={css.panel}
      aria-labelledby='taskboard-history-title'
      aria-busy={loading}
      data-testid='taskboard-history-panel'
    >
      <header className={css.head}>
        <div>
          <h3 id='taskboard-history-title' className={css.title}>历史任务</h3>
          <p className={css.subtitle} aria-live='polite'>{projectTitle} · 共 {total} 条</p>
        </div>
        <button type='button' className={css.close} onClick={onClose}>返回看板</button>
      </header>
      {items.length === 0
        ? <div className={css.empty}>当前工作区还没有历史任务</div>
        : (
          <div className={css.list}>
            {items.map(item => (
              <article key={item.id} className={css.item}>
                <div className={css.itemHead}>
                  <strong>{item.title}</strong>
                  <span className={item.integrationState === 'conflicted' ? css.conflicted : css.outcome}>{outcome(item)}</span>
                </div>
                <div className={css.meta}>
                  <span>{new Date(item.updatedAt).toLocaleString()}</span>
                  <span>{item.type}</span>
                  {item.commitRef !== undefined && <code title={item.commitRef}>{item.commitRef.slice(0, 12)}</code>}
                </div>
                {item.conflictTaskId !== undefined && <p className={css.note}>已生成冲突处理任务：{item.conflictTaskId.slice(0, 8)}</p>}
                {item.deliverySummary !== undefined && <p className={css.summary}>{item.deliverySummary}</p>}
                {item.sessionId !== undefined && (
                  <div className={css.actions}>
                    <button type='button' className={css.openSession} onClick={() => onOpenSession(item.sessionId!)}>打开会话</button>
                    {item.taskWorkspace !== undefined && (
                      <button type='button' className={css.cleanup} onClick={() => onCleanup(item)}>清理临时工作区</button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
          )}
      {items.length < total && (
        <button type='button' className={css.loadMore} onClick={onLoadMore} disabled={loading}>
          {loading ? '加载中…' : `加载更多（${items.length}/${total}）`}
        </button>
      )}
    </section>
  )
}
