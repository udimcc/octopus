/**
 * "Octopus will restart after the install" confirm (self-update). Mounted in the MAIN
 * window only (`App.tsx`), after `ProgressPanel` so it stacks above `SettingsModal`
 * (DOM order = paint order). While the install runs the buttons are disabled and neither
 * Escape nor a backdrop click closes it; on error the message shows and it can be closed
 * or retried (OK).
 *
 * Follows `.claude/rules/modals-and-overlays.md`. Listed in `IssuesDrawer`'s `topmostModal()`.
 */
import { useStore } from '../store/store'
import { overlayStyle, modalCardStyle, fontSize, color } from '../style/tokens'

export function RestartConfirmModal(): React.JSX.Element | null {
  const open = useStore((s) => s.restartConfirmOpen)
  const windowRole = useStore((s) => s.windowRole)
  const installState = useStore((s) => s.installState)
  const close = useStore((s) => s.closeRestartConfirm)
  const installUpdate = useStore((s) => s.installUpdate)
  const version = useStore((s) => s.restartConfirmVersion)
  if (!open || windowRole !== 'main' || !version) return null
  const installing = installState.kind === 'installing'
  // Move focus to the card BEFORE the buttons disable (Chromium drops focus to <body> otherwise).
  const install = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus()
    void installUpdate(version)
  }

  return (
    <div role="presentation" onClick={close} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Restart to update"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !installing) close()
        }}
        style={{ ...modalCardStyle, width: 420 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Install {version}?</h2>
        <p style={{ margin: 0 }}>Octopus will restart after the install.</p>
        {installing ? <p style={{ margin: 0 }}>Installing…</p> : null}
        {installState.kind === 'error' ? (
          <p role="alert" style={{ margin: 0, color: color.errorText }}>
            {installState.message}
          </p>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" autoFocus disabled={installing} onClick={close}>
            Not now
          </button>
          <button type="button" className="btn-primary" disabled={installing} onClick={install}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
