/**
 * "Discard unsaved changes?" confirm (DESIGN "Issues" §13.5). The Issues drawer
 * raises `discardPrompt` view-state whenever the user tries to close the drawer,
 * select another issue, or press Esc while `issueEditDirty` is set; this component
 * only renders the resulting two-way choice — the store owns which pending action
 * `onDiscard`/`onKeepEditing` resolves.
 *
 * Portaled to `document.body`: this is mounted as a DOM descendant of
 * the Issues drawer, which slides in via a CSS `transform` — that transform makes the
 * drawer the *containing block* for this dialog's `position: fixed` overlay, confining
 * it (and its click-to-dismiss backdrop) to the drawer's own bounds instead of the
 * whole window, leaving the Progress panel clickable right through it. Portaling
 * fixes that without giving up the overlay's full-viewport backdrop. `createPortal`
 * keeps React event bubbling (so `onClick`/`onKeyDown`'s `stopPropagation` still
 * reaches up through the drawer's own handlers exactly as before) — only the raw DOM
 * placement moves; see `IssuesDrawer`'s focus-retention effect, which listens on
 * `document` rather than its own root for the same reason.
 */

import { createPortal } from 'react-dom'
import { overlayStyle, modalCardStyle, fontSize } from '../style/tokens'

export interface DiscardChangesPromptProps {
  readonly onDiscard: () => void
  readonly onKeepEditing: () => void
}

export function DiscardChangesPrompt({
  onDiscard,
  onKeepEditing
}: DiscardChangesPromptProps): React.JSX.Element {
  return createPortal(
    <div role="presentation" onClick={onKeepEditing} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Discard unsaved changes"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onKeepEditing()
        }}
        style={{ ...modalCardStyle, width: 360 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Discard unsaved changes?</h2>
        <p style={{ margin: 0 }}>Your edits to this issue have not been saved.</p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" autoFocus onClick={onKeepEditing}>
            Keep editing
          </button>
          <button type="button" className="btn-danger" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
