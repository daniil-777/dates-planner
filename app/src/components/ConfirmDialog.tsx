import type { ReactNode } from 'react'
import { Bar, Button, Dialog } from '@ui5/webcomponents-react'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  children?: ReactNode
  onConfirm: () => void
  onCancel: () => void
  confirmText?: string
  cancelText?: string
  /** Paints the confirm button red — deleting a posting, clearing a period. */
  destructive?: boolean
  /** Disables the confirm button while the mutation behind it is in flight. */
  busy?: boolean
}

/**
 * "Are you sure" with a Fiori footer bar.
 *
 * The dialog is stretched on phones so the two buttons stay where a thumb expects them, and
 * cancel is the initial focus: the confirm path in this app posts documents and runs
 * payment runs, so the safe action is the one that should be one keystroke away.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  onConfirm,
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  destructive = false,
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      headerText={title}
      onClose={() => onCancel()}
      className="twm-confirm"
      data-testid="confirm-dialog"
      footer={
        <Bar
          design="Footer"
          endContent={
            <>
              <Button design="Transparent" onClick={() => onCancel()}>
                {cancelText}
              </Button>
              <Button
                design={destructive ? 'Negative' : 'Emphasized'}
                disabled={busy}
                onClick={() => onConfirm()}
              >
                {confirmText}
              </Button>
            </>
          }
        />
      }
    >
      <div className="twm-confirm__body">{children}</div>
    </Dialog>
  )
}

export default ConfirmDialog
