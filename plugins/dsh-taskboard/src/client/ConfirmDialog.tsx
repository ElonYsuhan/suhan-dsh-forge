/**
 * Destructive-action confirmation dialog (Radix AlertDialog, never window.confirm).
 * onPointerDownOutside → onCancel 保持原「点遮罩取消」行为；确认按钮自动聚焦。
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import css from './ConfirmDialog.module.css'

/** Confirm dialog surface props. */
export interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Render the confirmation dialog.
 * @param props - copy and callbacks.
 */
export function ConfirmDialog ({ title, message, confirmLabel = '确认', onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      <AlertDialog.Portal>
        {/* AlertDialog 语义上 Content 不允许点外关闭（只能按钮操作），
            这里在 Overlay 上直接拦 pointer-down 保持原「点遮罩取消」行为。 */}
        <AlertDialog.Overlay className={css.mask} onPointerDown={onCancel} />
        <div className={css.layer}>
          <AlertDialog.Content className={css.panel}>
            <AlertDialog.Title className={css.title}>{title}</AlertDialog.Title>
            <AlertDialog.Description className={css.message}>{message}</AlertDialog.Description>
            <footer className={css.foot}>
              <AlertDialog.Cancel asChild>
                <button type='button' className={css.cancelBtn}>取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button type='button' className={css.confirmBtn} autoFocus onClick={onConfirm} data-testid='taskboard-confirm-btn'>{confirmLabel}</button>
              </AlertDialog.Action>
            </footer>
          </AlertDialog.Content>
        </div>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
