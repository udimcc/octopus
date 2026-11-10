/**
 * "New version X.Y.Z is available" popup (self-update). Mounted in the MAIN window only
 * (`App.tsx`), after `ProgressPanel` in DOM order. Dismiss persists the dismissed version via
 * main (which re-broadcasts the status, hiding this); Install hands over to
 * `RestartConfirmModal`. Hidden while that confirm is open.
 *
 * Follows `.claude/rules/modals-and-overlays.md` (overlayStyle, aria-modal dialog,
 * tabIndex -1, onKeyDown stopPropagation then Escape = Dismiss, no blur). A backdrop click
 * does nothing; only Dismiss and Escape dismiss. Listed in
 * `IssuesDrawer`'s `topmostModal()`.
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../store/store'
import { topmostModal } from './IssuesDrawer'
import { showUpdatePopup } from '../store/update-status'
import { overlayStyle, modalCardStyle, fontSize } from '../style/tokens'

export function UpdateAvailableModal(): React.JSX.Element | null {
  const status = useStore((s) => s.updateStatus)
  const windowRole = useStore((s) => s.windowRole)
  const snoozed = useStore((s) => s.popupSnoozedVersion)
  const restartConfirmOpen = useStore((s) => s.restartConfirmOpen)
  const openRestartConfirm = useStore((s) => s.openRestartConfirm)
  const pushToast = useStore((s) => s.pushToast)
  const cardRef = useRef<HTMLDivElement>(null)
  const visible = showUpdatePopup(status, windowRole, snoozed) && !restartConfirmOpen
  useEffect(() => {
    // Only take focus when this card is the topmost dialog; else the Issues drawer's hand-off wins.
    if (visible && topmostModal() === cardRef.current) cardRef.current?.focus()
  }, [visible])
  if (!visible || !status?.availableVersion) return null
  const version = status.availableVersion
  const dismiss = (): void =>
    void window.octopusAPI.updates.dismiss(version).catch((e: unknown) => {
      pushToast('error', `Couldn't dismiss: ${e instanceof Error ? e.message : String(e)}`)
    })

  return (
    <div role="presentation" style={overlayStyle}>
      <div
        ref={cardRef}
        role="dialog"
        aria-label="Update available"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') dismiss()
        }}
        style={{ ...modalCardStyle, width: 420 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>New version {version} is available</h2>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={dismiss}>
            Dismiss
          </button>
          <button type="button" className="btn-primary" onClick={() => openRestartConfirm(version)}>
            Install
          </button>
        </div>
      </div>
    </div>
  )
}
