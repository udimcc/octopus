/**
 * Confirms deleting a task or issue that are bound to each other (1:1, DESIGN
 * "Issues" §13.1). Shown instead of a plain single-step confirm whenever the task or
 * issue being deleted has a binding on the other side.
 *
 * Purely presentational: the caller (`DeleteTaskConfirm` from the task side,
 * `IssueDetail` from the issue side) owns the actual `tasks.delete`/`issues.delete`/
 * `onDeleteBoundTask` dispatch for each choice and feeds the outcome back via
 * `busy`/`error`. No backdrop blur or filter (VMware VDI / SwiftShader, no GPU).
 *
 * Portaled to `document.body`: from the issue side this is mounted
 * deep inside the Issues drawer, whose slide-in CSS `transform` becomes the
 * *containing block* for a `position: fixed` descendant — without the portal, this
 * dialog's full-viewport backdrop would be confined to the drawer's own bounds,
 * leaving the Progress panel clickable right through it. From the task side
 * (`DeleteTaskConfirm`, not nested under the drawer) the portal is a no-op by
 * comparison — same visual result either way, so one implementation covers both.
 * `createPortal` only moves the raw DOM placement; React event bubbling (so
 * `onClick`/`onKeyDown`'s `stopPropagation`) is unaffected.
 */

import { createPortal } from 'react-dom'
import { overlayStyle, modalCardStyle, color, fontSize } from '../style/tokens'

export type BoundDeleteChoice = 'task' | 'issue' | 'both'

export interface BoundDeleteDialogProps {
  readonly taskName: string
  readonly issueName: string
  readonly onChoose: (choice: BoundDeleteChoice) => void
  readonly onCancel: () => void
  readonly busy?: boolean
  readonly error?: string | null
}

export function BoundDeleteDialog({
  taskName,
  issueName,
  onChoose,
  onCancel,
  busy,
  error
}: BoundDeleteDialogProps): React.JSX.Element {
  return createPortal(
    <div role="presentation" onClick={busy ? undefined : onCancel} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Delete linked task and issue"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) onCancel()
        }}
        style={{ ...modalCardStyle, width: 440 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Delete task or issue?</h2>
        <p style={{ margin: 0 }}>
          &quot;{taskName}&quot; is linked to issue &quot;{issueName}&quot;. Choose what to delete.
        </p>

        {error ? (
          <p role="alert" style={{ margin: 0, color: color.errorText }}>
            {error}
          </p>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" autoFocus onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => onChoose('task')} disabled={busy}>
            Delete task only
          </button>
          <button type="button" onClick={() => onChoose('issue')} disabled={busy}>
            Delete issue only
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => onChoose('both')}
            disabled={busy}
          >
            Delete both
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
