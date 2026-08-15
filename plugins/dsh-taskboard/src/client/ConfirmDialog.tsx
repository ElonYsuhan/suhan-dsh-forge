/**
 * Destructive-action confirmation dialog (never window.confirm).
 */
import { useId } from 'react'
import css from './ConfirmDialog.module.css'
import { useDialogFocus } from './useDialogFocus.ts'

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
  const titleId = useId()
  const messageId = useId()
  const panelRef = useDialogFocus<HTMLDivElement>(onCancel)
  return (
    <div className={css.mask} onClick={onCancel}>
      <div
        className={css.panel}
        ref={panelRef}
        role='alertdialog'
        aria-modal='true'
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onClick={ev => ev.stopPropagation()}
      >
        <h3 className={css.title} id={titleId}>{title}</h3>
        <p className={css.message} id={messageId}>{message}</p>
        <footer className={css.foot}>
          <button type='button' className={css.cancelBtn} onClick={onCancel}>取消</button>
          <button type='button' className={css.confirmBtn} onClick={onConfirm} data-dialog-initial-focus>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  )
}
