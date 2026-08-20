/**
 * 看板设置弹窗：复用 SettingsForm 编辑自定义环节（列）与工作项类型。
 */
import type { Board, ColumnDef, ItemTypeDef } from '../shared/types.ts'
import css from './SettingsEditor.module.css'
import { SettingsForm } from './SettingsForm.tsx'
import { useDialogFocus } from './useDialogFocus.ts'

/** Settings surface props. */
export interface SettingsEditorProps {
  board: Board
  onCancel: () => void
  onSave: (settings: { columns: ColumnDef[]; itemTypes: ItemTypeDef[] }) => void
}

/**
 * Render the settings dialog (modal shell around SettingsForm).
 * @param props - the board and callbacks.
 */
export function SettingsEditor ({ board, onCancel, onSave }: SettingsEditorProps) {
  const panelRef = useDialogFocus<HTMLDivElement>(onCancel)

  return (
    <div className={css.mask} onClick={onCancel}>
      <div
        className={css.panel}
        ref={panelRef}
        role='dialog'
        aria-modal='true'
        aria-label='看板设置'
        onClick={ev => ev.stopPropagation()}
        tabIndex={-1}
      >
        <header className={css.head}>
          <h3 className={css.title}>看板设置</h3>
          <button type='button' className={css.closeBtn} onClick={onCancel} aria-label='关闭'>✕</button>
        </header>

        <SettingsForm board={board} onCancel={onCancel} onSave={onSave} />
      </div>
    </div>
  )
}
