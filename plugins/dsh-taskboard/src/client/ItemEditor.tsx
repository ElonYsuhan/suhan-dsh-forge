/**
 * 工作项编辑弹窗：类型 / 标题 / 描述 / 优先级 / 标签 / 迭代 / 追溯父级 / 环节。
 */
import { useState, type FormEvent } from 'react'
import { PRIORITIES, executionModeOf, type Board, type ExecutionMode, type Priority, type WorkItem } from '../shared/types.ts'
import type { ItemInput } from './api.ts'
import css from './ItemEditor.module.css'

/** Editor surface props. */
export interface ItemEditorProps {
  /** 正在编辑的工作项；null 为新建 */
  item: WorkItem | null
  board: Board
  /** 新建时预选的环节 */
  defaultStatus?: string | undefined
  onCancel: () => void
  onSave: (input: ItemInput) => void
}

/**
 * Render the editor dialog.
 * @param props - the item under edit, the board (类型/环节/父级选项), and callbacks.
 */
export function ItemEditor ({ item, board, defaultStatus, onCancel, onSave }: ItemEditorProps) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [type, setType] = useState(item?.type ?? board.itemTypes[0]?.key ?? 'task')
  const [desc, setDesc] = useState(item?.desc ?? '')
  const [priority, setPriority] = useState<Priority>(item?.priority ?? 'medium')
  const [labels, setLabels] = useState(item?.labels.join('、') ?? '')
  const [iteration, setIteration] = useState(item?.iteration ?? '')
  const [parentId, setParentId] = useState(item?.parentId ?? '')
  const [status, setStatus] = useState(item?.status ?? defaultStatus ?? board.columns[0]?.id ?? 'todo')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(item === null ? 'auto' : executionModeOf(item))

  const candidates = board.items.filter(i => i.id !== item?.id && !i.archived)

  const handleSubmit = (ev: FormEvent): void => {
    ev.preventDefault()
    const trimmed = title.trim()
    if (trimmed === '') return
    onSave({
      type,
      title: trimmed,
      desc: desc.trim(),
      priority,
      labels: labels.split(/[、,，]/).map(s => s.trim()).filter(s => s !== ''),
      parentId: parentId === '' ? undefined : parentId,
      iteration: iteration.trim() === '' ? undefined : iteration.trim(),
      status,
      executionMode
    })
  }

  return (
    <div className={css.mask} onClick={onCancel}>
      <form
        className={css.panel}
        role='dialog'
        aria-label={item === null ? '新建工作项' : '编辑工作项'}
        onClick={ev => ev.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className={css.head}>
          <h3 className={css.title}>{item === null ? '新建工作项' : '编辑工作项'}</h3>
          <button type='button' className={css.closeBtn} onClick={onCancel} aria-label='关闭'>✕</button>
        </header>

        <div className={css.row}>
          <label className={css.field}>
            <span className={css.fieldLabel}>类型</span>
            <select className={css.select} value={type} onChange={ev => setType(ev.target.value)}>
              {board.itemTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>优先级</span>
            <select className={css.select} value={priority} onChange={ev => setPriority(ev.target.value as Priority)}>
              {PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>标题</span>
          <input
            className={css.input}
            value={title}
            onChange={ev => setTitle(ev.target.value)}
            placeholder='工作项标题'
            autoFocus
            required
            data-testid='taskboard-editor-title'
          />
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>描述</span>
          <textarea
            className={css.textarea}
            value={desc}
            onChange={ev => setDesc(ev.target.value)}
            placeholder='目标、范围、验收标准…'
            rows={3}
          />
        </label>

        <div className={css.row}>
          <label className={css.field}>
            <span className={css.fieldLabel}>追溯父级</span>
            <select className={css.select} value={parentId} onChange={ev => setParentId(ev.target.value)}>
              <option value=''>（无）</option>
              {candidates.map(i => <option key={i.id} value={i.id}>{i.title}</option>)}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>迭代</span>
            <input className={css.input} value={iteration} onChange={ev => setIteration(ev.target.value)} placeholder='如 2026-08 S2' />
          </label>
        </div>

        <div className={css.row}>
          <label className={css.field}>
            <span className={css.fieldLabel}>执行方式</span>
            <select className={css.select} value={executionMode} onChange={ev => setExecutionMode(ev.target.value as ExecutionMode)}>
              <option value='auto'>小任务 · AI 自主推进</option>
              <option value='review'>重大任务 · 每环节人工审核</option>
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>环节</span>
            <select className={css.select} value={status} onChange={ev => setStatus(ev.target.value)}>
              {board.columns.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>标签（、分隔）</span>
            <input className={css.input} value={labels} onChange={ev => setLabels(ev.target.value)} placeholder='如 工程、迁移' />
          </label>
        </div>

        <footer className={css.foot}>
          <button type='button' className={css.cancelBtn} onClick={onCancel}>取消</button>
          <button type='submit' className={css.saveBtn} disabled={title.trim() === ''}>保存</button>
        </footer>
      </form>
    </div>
  )
}
