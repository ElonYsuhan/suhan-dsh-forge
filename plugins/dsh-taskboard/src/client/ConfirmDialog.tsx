/**
 * Destructive-action confirmation dialog (never window.confirm).
 */
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
    <div className={css.mask} onClick={onCancel}>
      <div
        className={css.panel}
        role='alertdialog'
        aria-label={title}
        onClick={ev => ev.stopPropagation()}
      >
        <h3 className={css.title}>{title}</h3>
        <p className={css.message}>{message}</p>
        <footer className={css.foot}>
          <button type='button' className={css.cancelBtn} onClick={onCancel}>取消</button>
          <button type='button' className={css.confirmBtn} onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  )
}
