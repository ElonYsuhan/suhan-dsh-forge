/**
 * 看板设置表单：自定义环节（列）与工作项类型。
 * 由看板内设置弹窗和 DSH 设置页复用，不包含 modal 外壳。
 */
import { useState, type FormEvent } from 'react'
import type { Board, ColumnDef, ItemTypeDef } from '../shared/types.ts'
import css from './SettingsEditor.module.css'

/** Settings form props. */
export interface SettingsFormProps {
  board: Board
  onCancel: () => void
  onSave: (settings: { columns: ColumnDef[]; itemTypes: ItemTypeDef[] }) => void
}

/** 新环节临时 id */
let seq = 0
function nextId (): string {
  seq += 1
  return `custom-${Date.now().toString(36)}-${seq}`
}

/**
 * Render the editable settings form (columns and item types).
 * @param props - the board and callbacks.
 */
export function SettingsForm ({ board, onCancel, onSave }: SettingsFormProps) {
  const [columns, setColumns] = useState<ColumnDef[]>(board.columns.map(c => ({ ...c })))
  const [itemTypes, setItemTypes] = useState<ItemTypeDef[]>(board.itemTypes.map(t => ({ ...t })))
  const [error, setError] = useState<string | null>(null)

  const setColumnLabel = (id: string, label: string): void => {
    setColumns(prev => prev.map(c => c.id === id ? { ...c, label } : c))
  }
  const removeColumn = (id: string): void => {
    setColumns(prev => prev.filter(c => c.id !== id))
  }
  const addColumn = (): void => {
    setColumns(prev => [...prev, { id: nextId(), label: '新环节' }])
  }

  const setTypeField = (key: string, field: 'label' | 'color', value: string): void => {
    setItemTypes(prev => prev.map(t => t.key === key ? { ...t, [field]: value } : t))
  }
  const removeType = (key: string): void => {
    setItemTypes(prev => prev.filter(t => t.key !== key))
  }
  const addType = (): void => {
    setItemTypes(prev => [...prev, { key: nextId(), label: '新类型', color: '#8ea5ba' }])
  }

  const handleSubmit = (ev: FormEvent): void => {
    ev.preventDefault()
    if (columns.length === 0) {
      setError('至少保留一个环节')
      return
    }
    if (columns.some(c => c.label.trim() === '')) {
      setError('环节名不能为空')
      return
    }
    if (itemTypes.length === 0) {
      setError('至少保留一个类型')
      return
    }
    setError(null)
    onSave({
      columns: columns.map(c => ({ ...c, label: c.label.trim() })),
      itemTypes: itemTypes.map(t => ({ ...t, label: t.label.trim() }))
    })
  }

  return (
    <form className={css.form} onSubmit={handleSubmit}>
      <section className={css.group}>
        <div className={css.groupHead}>
          <h4 className={css.groupTitle}>环节（列）</h4>
          <button type='button' className={css.addBtn} onClick={addColumn}>+ 添加环节</button>
        </div>
        <ul className={css.list}>
          {columns.map((column, idx) => (
            <li key={column.id} className={css.rowItem}>
              <span className={css.idx}>{idx + 1}</span>
              <input
                className={css.input}
                value={column.label}
                onChange={ev => setColumnLabel(column.id, ev.target.value)}
                aria-label={`环节 ${idx + 1} 名称`}
              />
              <button type='button' className={css.delBtn} onClick={() => removeColumn(column.id)} aria-label={`删除环节 ${column.label}`}>删除</button>
            </li>
          ))}
        </ul>
      </section>

      <section className={css.group}>
        <div className={css.groupHead}>
          <h4 className={css.groupTitle}>工作项类型</h4>
          <button type='button' className={css.addBtn} onClick={addType}>+ 添加类型</button>
        </div>
        <ul className={css.list}>
          {itemTypes.map(type => (
            <li key={type.key} className={css.rowItem}>
              <input
                className={css.input}
                value={type.label}
                onChange={ev => setTypeField(type.key, 'label', ev.target.value)}
                aria-label={`类型 ${type.label} 名称`}
              />
              <input
                className={`${css.input} ${css.colorInput}`}
                type='color'
                value={type.color}
                onChange={ev => setTypeField(type.key, 'color', ev.target.value)}
                aria-label={`类型 ${type.label} 颜色`}
              />
              <button type='button' className={css.delBtn} onClick={() => removeType(type.key)} aria-label={`删除类型 ${type.label}`}>删除</button>
            </li>
          ))}
        </ul>
      </section>

      {error !== null && <div className={css.error} role='alert'>{error}</div>}

      <footer className={css.foot}>
        <button type='button' className={css.cancelBtn} onClick={onCancel}>取消</button>
        <button type='submit' className={css.saveBtn}>保存设置</button>
      </footer>
    </form>
  )
}
