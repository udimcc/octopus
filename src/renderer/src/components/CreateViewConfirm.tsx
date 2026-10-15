/**
 * Confirmation dialog for "+ New Window From Task" (window-view feature, Task 2/3)
 * when the task has sessions hosted in this window's group — `createView` bulk-moves
 * them into the new view window, so the user is warned before that happens. (A task
 * with no such sessions skips this dialog entirely — `ProgressPanel.requestCreateView`.)
 *
 * Follows the shared modal/overlay contract (`.claude/rules/modals-and-overlays.md`):
 * `overlayStyle`/`modalCardStyle` backdrop+card from `style/tokens.ts` (shared
 * `zIndex: 100`, no `backdrop-filter`/blur), `role="dialog"` + `aria-modal="true"` +
 * `tabIndex={-1}`, and `onKeyDown` on the card stops propagation for every key then
 * handles its own Escape — so a chord typed while this is open never reaches the
 * window-level shortcut listener. Added to `IssuesDrawer`'s `topmostModal()` list.
 */

import { overlayStyle, modalCardStyle, fontSize } from '../style/tokens'

export interface CreateViewConfirmProps {
  readonly taskName: string
  readonly onClose: () => void
  readonly onConfirm: () => void
}

export function CreateViewConfirm({
  taskName,
  onClose,
  onConfirm
}: CreateViewConfirmProps): React.JSX.Element {
  return (
    <div role="presentation" onClick={onClose} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="New Window From Task"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
        style={{ ...modalCardStyle, width: 420 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Open "{taskName}" in a new window?</h2>
        <p style={{ margin: 0 }}>
          This task's sessions will move to the new window, which will stay pinned to it.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" autoFocus onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            Open window
          </button>
        </div>
      </div>
    </div>
  )
}
