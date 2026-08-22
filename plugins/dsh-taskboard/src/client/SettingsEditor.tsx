/**
 * 看板设置弹窗（Radix Dialog）：复用 SettingsForm 编辑自定义环节（列）与工作项类型。
 */
import * as Dialog from '@radix-ui/react-dialog'
import type { Board, ColumnDef, ItemTypeDef } from '../shared/types.ts'
import css from './SettingsEditor.module.css'
import { SettingsForm } from './SettingsForm.tsx'

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
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={css.mask} />
        <div className={css.layer}>
          <Dialog.Content className={css.panel} aria-label='看板设置'>
            <header className={css.head}>
              <h3 className={css.title}>看板设置</h3>
              <Dialog.Close asChild>
                <button type='button' className={css.closeBtn} aria-label='关闭'>✕</button>
              </Dialog.Close>
            </header>

            <SettingsForm board={board} onCancel={onCancel} onSave={onSave} />
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
