/**
 * The settings dialog (DESIGN §5.4). Edits the user-facing V1 settings —
 * `worktree.location` (base dir for native worktrees; blank → the backend's
 * home-based default), `terminal.shell` (blank → the backend default), and the two
 * free-form session-switch chords (`sessionNextKey` / `sessionPrevKey`) — and saves
 * them via `app.updateSettings(patch)`.
 *
 * A session-switch chord is captured by pressing keys: it must carry ≥1 modifier
 * (`hasModifier`) so it can't shadow a bare terminal keystroke, and it must not
 * collide with a fixed shortcut (`RESERVED_CHORDS`) or the other direction. A
 * bad/colliding capture surfaces inline and disables Save.
 *
 * `updateSettings` emits NO event (it isn't part of the workspace event stream),
 * so after a successful save we re-fetch `app.getState()` and re-`hydrate` to pull
 * the persisted values back into the store. The patch is a deep-partial
 * (`SettingsPatchDTO`): only edited fields are sent.
 */

import { useState } from 'react'
import { useStore } from '../store/store'
import { overlayStyle, modalCardStyle, color, fontSize } from '../style/tokens'
import {
  hasModifier,
  isModifierCode,
  modifierPrefix,
  parseChord,
  chordLabel,
  RESERVED_CHORDS
} from '../keybindings/chords'
import type { SettingsPatchDTO } from '../../../shared/dto'

export interface SettingsModalProps {
  readonly onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const hydrate = useStore((s) => s.hydrate)
  const [location, setLocation] = useState(settings.worktree.location)
  const [shell, setShell] = useState(settings.terminal.shell ?? '')
  const [nextKey, setNextKey] = useState(settings.sessionNextKey ?? 'Ctrl+Shift+ArrowRight')
  const [prevKey, setPrevKey] = useState(settings.sessionPrevKey ?? 'Ctrl+Shift+ArrowLeft')
  // Which direction field is currently capturing (null → none).
  const [capturing, setCapturing] = useState<'next' | 'prev' | null>(null)
  // The modifiers held so far during the active capture (live preview), e.g. `Ctrl+Shift`.
  const [preview, setPreview] = useState('')
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Name of the action already bound to `chord`, or null if free. Checks the fixed
  // shortcuts (`RESERVED_CHORDS`) and the OTHER session-switch direction, so two
  // actions can never fire on one keypress (§5.4).
  const conflictLabel = (chord: string, target: 'next' | 'prev'): string | null => {
    const reserved = RESERVED_CHORDS.find((r) => r.chord === chord)
    if (reserved) return reserved.label
    const other = target === 'next' ? prevKey : nextKey
    if (chord === other) return target === 'next' ? 'Previous session' : 'Next session'
    return null
  }

  // Capture a session-switch chord for one direction, building it live as keys go
  // down. A modifier-only keydown (Ctrl/Shift/…) is NOT a complete chord — it just
  // updates the preview so the user sees the chord forming and can keep adding keys.
  // The chord commits on the first NON-modifier key (any key — letter, digit, arrow,
  // e.g. `Ctrl+Shift+T`) while ≥1 modifier is held (§5.4) — the modifier keeps it off
  // bare terminal keystrokes. A bare (modifier-less) final key is rejected inline, and
  // a chord already owned by another action surfaces a conflict. Directions are
  // independent. `onKeyUp` keeps the preview in sync as modifiers are released.
  const captureChord = (target: 'next' | 'prev', e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (isModifierCode(e.nativeEvent.code)) {
      setPreview(modifierPrefix(e.nativeEvent))
      setSwitchError(null)
      return
    }
    if (!hasModifier(e.nativeEvent)) {
      setSwitchError('Add at least one modifier (Ctrl / Alt / Shift)')
      return
    }
    const chord = parseChord(e.nativeEvent)
    const owner = conflictLabel(chord, target)
    if (target === 'next') setNextKey(chord)
    else setPrevKey(chord)
    setSwitchError(owner ? `Already used by ${owner}` : null)
    setPreview('')
    setCapturing(null)
  }

  // While capturing, releasing a modifier must shrink the preview to match. The final
  // key's keyup is ignored because `captureChord` already cleared `capturing`.
  const trackRelease = (e: React.KeyboardEvent): void => {
    setPreview(modifierPrefix(e.nativeEvent))
  }

  // Start capturing for one direction: arm the field and clear any prior preview/error.
  const startCapture = (target: 'next' | 'prev'): void => {
    setCapturing(target)
    setPreview('')
    setSwitchError(null)
  }

  // Save is blocked only while a COMMITTED chord collides (a format-rejected capture
  // never commits, so it can't yield an invalid saved value — and letting it block
  // Save would strand the dialog once the inline error scrolls out of view). Both
  // directions are re-checked so a next==prev collision is caught from either side.
  const nextConflict = conflictLabel(nextKey, 'next')
  const prevConflict = conflictLabel(prevKey, 'prev')
  const saveBlocked = nextConflict !== null || prevConflict !== null

  const save = (): void => {
    if (saveBlocked) return
    setBusy(true)
    setError(null)
    const patch: SettingsPatchDTO = {
      worktree: { location: location.trim() },
      terminal: { shell: shell.trim() || undefined },
      sessionNextKey: nextKey,
      sessionPrevKey: prevKey
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

        <label style={field}>
          <span>Next session shortcut</span>
          <button
            type="button"
            aria-label="next session shortcut"
            disabled={busy}
            onClick={() => startCapture('next')}
            onBlur={() => {
              if (capturing === 'next') {
                setCapturing(null)
                setPreview('')
              }
            }}
            onKeyDown={capturing === 'next' ? (e) => captureChord('next', e) : undefined}
            onKeyUp={capturing === 'next' ? trackRelease : undefined}
          >
            {capturing === 'next'
              ? preview
                ? `${preview}+…`
                : 'Press a shortcut…'
              : chordLabel(nextKey)}
          </button>
          {capturing === 'next' && switchError ? (
            <span role="alert" style={{ color: color.errorText }}>
              {switchError}
            </span>
          ) : nextConflict ? (
            <span role="alert" style={{ color: color.errorText }}>
              Already used by {nextConflict}
            </span>
          ) : null}
        </label>

        <label style={field}>
          <span>Previous session shortcut</span>
          <button
            type="button"
            aria-label="previous session shortcut"
            disabled={busy}
            onClick={() => startCapture('prev')}
            onBlur={() => {
              if (capturing === 'prev') {
                setCapturing(null)
                setPreview('')
              }
            }}
            onKeyDown={capturing === 'prev' ? (e) => captureChord('prev', e) : undefined}
            onKeyUp={capturing === 'prev' ? trackRelease : undefined}
          >
            {capturing === 'prev'
              ? preview
                ? `${preview}+…`
                : 'Press a shortcut…'
              : chordLabel(prevKey)}
          </button>
          {capturing === 'prev' && switchError ? (
            <span role="alert" style={{ color: color.errorText }}>
              {switchError}
            </span>
          ) : prevConflict ? (
            <span role="alert" style={{ color: color.errorText }}>
              Already used by {prevConflict}
            </span>
          ) : null}
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
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={busy || saveBlocked}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
