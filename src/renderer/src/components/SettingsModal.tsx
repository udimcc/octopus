/**
 * The settings dialog (DESIGN §5.4). Edits the two user-facing V1 settings —
 * `worktree.location` (base dir for native worktrees; blank → the backend's
 * home-based default) and `terminal.shell` (blank → the backend default) — and
 * saves them via `app.updateSettings(patch)`.
 *
 * `updateSettings` emits NO event (it isn't part of the workspace event stream),
 * so after a successful save we re-fetch `app.getState()` and re-`hydrate` to pull
 * the persisted values back into the store. The patch is a deep-partial
 * (`SettingsPatchDTO`): only edited fields are sent.
 */

import { useState } from 'react'
import { useStore } from '../store/store'
import { overlayStyle, modalCardStyle, color, fontSize } from '../style/tokens'
import type { SettingsPatchDTO } from '../../../shared/dto'

export interface SettingsModalProps {
  readonly onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const hydrate = useStore((s) => s.hydrate)
  const [location, setLocation] = useState(settings.worktree.location)
  const [shell, setShell] = useState(settings.terminal.shell ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    setBusy(true)
    setError(null)
    const patch: SettingsPatchDTO = {
      worktree: { location: location.trim() },
      terminal: { shell: shell.trim() || undefined }
    }
    void window.octopusAPI.app.updateSettings(patch).then((ack) => {
      if (!ack.ok) {
        setBusy(false)
        setError(ack.error ?? 'Failed to save settings')
        return
      }
      // No event is emitted for settings — refetch to reflect the saved values.
      void window.octopusAPI.app.getState().then((state) => {
        hydrate(state)
        onClose()
      })
    })
  }

  const field: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    color: color.textSecondary,
    fontSize: fontSize.sm
  }

  return (
    <div role="presentation" onClick={onClose} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) onClose()
        }}
        style={{ ...modalCardStyle, width: 460 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Settings</h2>

        <label style={field}>
          <span>Worktree base directory</span>
          <input
            aria-label="worktree location"
            value={location}
            placeholder="(default: ~/… )"
            disabled={busy}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>

        <label style={field}>
          <span>Terminal shell</span>
          <input
            aria-label="terminal shell"
            value={shell}
            placeholder="(default: login shell)"
            disabled={busy}
            onChange={(e) => setShell(e.target.value)}
          />
        </label>

        {error ? (
          <p role="alert" style={{ margin: 0, color: color.errorText }}>
            {error}
          </p>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
