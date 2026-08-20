/**
 * 看板主体：按自定义环节（列）渲染工作项，支持跨列拖拽流转。
 */
import { useState, type DragEvent } from 'react'
import type { Board as BoardModel, WorkItem } from '../shared/types.ts'
import { ItemCard } from './ItemCard.tsx'
import css from './Board.module.css'

/** Board surface props. */
export interface BoardProps {
  board: BoardModel
  onMove: (itemId: string, status: string) => void
  onSelect: (item: WorkItem) => void
  onAdd: (status: string) => void
}

/**
 * Render the board columns.
 * @param props - board data and callbacks.
 */
export function Board ({ board, onMove, onSelect, onAdd }: BoardProps) {
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  const typeOf = (item: WorkItem): ReturnType<typeof board.itemTypes.find> =>
    board.itemTypes.find(t => t.key === item.type)
  const parentOf = (item: WorkItem): string | undefined =>
    item.parentId === undefined
      ? undefined
      : board.items.find(i => i.id === item.parentId)?.title

  const handleDragOver = (status: string) => (ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'move'
    setDragOver(status)
  }

  const handleDrop = (status: string) => (ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault()
    setDragOver(null)
    const id = ev.dataTransfer.getData('text/plain')
    if (id !== '') onMove(id, status)
  }

  return (
    <div className={css.board}>
      {board.columns.map((column, index) => {
        const items = board.items.filter(i => i.status === column.id && !i.archived)
        return (
          <section
            key={column.id}
            className={`${css.column} ${dragOver === column.id ? css.columnDragOver : ''}`}
            data-status={column.id}
            aria-label={column.label}
            onDragOver={handleDragOver(column.id)}
            onDragLeave={() => setDragOver(prev => prev === column.id ? null : prev)}
            onDrop={handleDrop(column.id)}
          >
            <header className={css.columnHead}>
              <span className={css.columnTitle}>{column.label}</span>
              <span className={css.columnCount}>{items.length}</span>
            </header>
            <div className={css.columnBody}>
              {items.map(item => (
                <ItemCard
                  key={item.id}
                  item={item}
                  typeDef={typeOf(item)}
                  parentTitle={parentOf(item)}
                  dragging={dragging === item.id}
                  onDragStart={() => setDragging(item.id)}
                  onDragEnd={() => setDragging(null)}
                  onSelect={() => onSelect(item)}
                />
              ))}
              {items.length === 0 && <div className={css.columnEmpty}>拖拽工作项到此环节</div>}
            </div>
            {index === 0 && (
              <button
                type='button'
                className={css.addBtn}
                onClick={() => onAdd(column.id)}
                data-testid={`taskboard-add-${column.id}`}
              >
                + 新建
              </button>
            )}
          </section>
        )
      })}
    </div>
  )
}
