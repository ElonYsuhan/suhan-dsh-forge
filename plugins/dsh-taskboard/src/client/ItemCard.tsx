/**
 * 工作项卡片：类型徽标 / 标题 / 优先级 / 迭代 / 标签 / 追溯父级 / 会话状态。
 * 可拖拽（dataTransfer 携带 item id），点击打开详情。
 */
import type { DragEvent } from 'react'
import { executionModeOf, executionStateOf, type ItemTypeDef, type WorkItem } from '../shared/types.ts'
import css from './ItemCard.module.css'

/** ItemCard surface props. */
export interface ItemCardProps {
  item: WorkItem
  /** 类型定义（决定徽标颜色/名称） */
  typeDef?: ItemTypeDef | undefined
  /** 追溯父级标题（史诗/需求名） */
  parentTitle?: string | undefined
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onSelect: () => void
}

/** 优先级徽标文案 */
const PRIORITY_LABEL: Record<string, string> = {
  low: '低', medium: '中', high: '高', urgent: '紧急'
}

const STATE_LABEL: Record<string, string> = {
  running: '执行中',
  'awaiting-review': '待审核',
  blocked: '阻塞',
  'awaiting-delivery': '待交付确认',
  committing: '提交中',
  failed: '失败'
}

/**
 * Render one card.
 * @param props - the item and interaction callbacks.
 */
export function ItemCard ({ item, typeDef, parentTitle, dragging, onDragStart, onDragEnd, onSelect }: ItemCardProps) {
  const executionState = executionStateOf(item)
  const locked = executionState === 'running' || executionState === 'awaiting-review' || executionState === 'awaiting-delivery' || executionState === 'committing'
  const handleDragStart = (ev: DragEvent<HTMLButtonElement>): void => {
    if (locked) {
      ev.preventDefault()
      return
    }
    ev.dataTransfer.setData('text/plain', item.id)
    ev.dataTransfer.effectAllowed = 'move'
    onDragStart()
  }

  return (
    <button
      type='button'
      className={`${css.card} ${dragging ? css.cardDragging : ''}`}
      draggable={!locked}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      data-testid='taskboard-item'
    >
      <div className={css.cardTop}>
        <span className={css.typeBadge} style={{ color: typeDef?.color, borderColor: typeDef?.color }}>
          {typeDef?.label ?? item.type}
        </span>
        <span className={`${css.priority} ${css['p' + item.priority]}`}>
          {PRIORITY_LABEL[item.priority] ?? item.priority}
        </span>
      </div>
      <div className={css.cardTitle}>{item.title}</div>
      {item.desc !== '' && <div className={css.cardDesc}>{item.desc}</div>}
      <div className={css.cardMeta}>
        <span className={css.mode}>{executionModeOf(item) === 'review' ? '重大任务' : 'AI 自主'}</span>
        {STATE_LABEL[executionState] !== undefined && <span className={css.executionState}>{STATE_LABEL[executionState]}</span>}
        {parentTitle !== undefined && <span className={css.parent} title={`追溯：${parentTitle}`}>⬆ {parentTitle}</span>}
        {item.iteration !== undefined && item.iteration !== '' && <span className={css.iteration}>{item.iteration}</span>}
        {item.sessionId !== undefined && <span className={css.sessionDot} title='已关联会话'>●</span>}
      </div>
      {item.labels.length > 0 && (
        <div className={css.labels}>
          {item.labels.map(label => <span key={label} className={css.label}>{label}</span>)}
        </div>
      )}
    </button>
  )
}
