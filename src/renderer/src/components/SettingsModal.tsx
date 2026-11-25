/**
 * The settings dialog (DESIGN §5.4). Edits the user-facing V1 settings —
 * `worktree.location` (base dir for native worktrees; blank → the backend's
 * home-based default), `terminal.shell` (blank → the backend default), and the
 * free-form configurable chords (next/prev session, next/prev task, new session, new
 * task, close session, terminal search, copy, paste, toggle issues) — and saves them via
 * `app.updateSettings(patch)`.
 *
 * The settings are grouped into categories shown as a left sidebar; clicking a
 * category swaps the content pane. As more options accrue this keeps the dialog
 * navigable rather than a single ever-growing scroll. All categories share one
 * form/save cycle — switching category never discards in-progress edits (the field
 * state lives on this component, not the panels), and Save persists everything.
 *
 * A chord is captured by pressing keys: it must carry ≥1 modifier (`hasModifier`) so
 * it can't shadow a bare terminal keystroke, and it must not collide with a fixed
 * shortcut (`RESERVED_CHORDS`) or any OTHER configurable chord. A bad/colliding
 * capture surfaces inline and disables Save (from any category, since the whole form
 * saves together).
 *
 * `updateSettings` emits NO event (it isn't part of the workspace event stream),
 * so after a successful save we re-fetch `app.getState()` and re-`hydrate` to pull
 * the persisted values back into the store. The patch is a deep-partial
 * (`SettingsPatchDTO`): only edited fields are sent.
 *
 * The General tab also hosts the Jira API key (DESIGN §13.7, invariant I16: never
 * persist secrets). That field is a wholly separate save/clear flow through
 * `credentials.setJiraKey`/`hasJiraKey` — it never joins `SettingsPatchDTO`, never
 * calls `app.updateSettings`, and never enters the store. The key itself is never
 * read back from the backend, only whether one is currently stored.
 */

import { useEffect, useState } from 'react'
import { useStore } from '../store/store'
import { overlayStyle, modalCardStyle, color, fontSize, radius } from '../style/tokens'
import {
  hasModifier,
  isModifierCode,
  modifierPrefix,
  parseChord,
  chordLabel,
  modifierPreviewLabel,
  modifierRequiredHint,
  RESERVED_CHORDS
} from '../keybindings/chords'
import { rendererOs } from '../platform'
import { defaultKeybindings, type KeybindingKey } from '../../../shared/keybindings'
import type { SettingsPatchDTO } from '../../../shared/dto'

export interface SettingsModalProps {
  readonly onClose: () => void
}

/** The configurable chord settings, in display order. `key` is the `SettingsDTO` field. */
type ChordKey = KeybindingKey

interface ChordFieldDef {
  readonly key: ChordKey
  readonly label: string
}

/** Defaults come from `defaultKeybindings(rendererOs())` (shared with the store/adapter). */
const CHORD_FIELDS: ReadonlyArray<ChordFieldDef> = [
  { key: 'sessionNextKey', label: 'Next session' },
  { key: 'sessionPrevKey', label: 'Previous session' },
  { key: 'taskNextKey', label: 'Next task' },
  { key: 'taskPrevKey', label: 'Previous task' },
  { key: 'newSessionKey', label: 'New session' },
  { key: 'newTaskKey', label: 'New task' },
  { key: 'closeSessionKey', label: 'Close session' },
  { key: 'searchKey', label: 'Terminal search' },
  { key: 'copyKey', label: 'Copy' },
  { key: 'pasteKey', label: 'Paste' },
  { key: 'issuesKey', label: 'Toggle Issues' },
  { key: 'splitRightKey', label: 'Split pane right' },
  { key: 'splitDownKey', label: 'Split pane down' },
  { key: 'focusPaneLeftKey', label: 'Focus pane left' },
  { key: 'focusPaneRightKey', label: 'Focus pane right' },
  { key: 'focusPaneUpKey', label: 'Focus pane up' },
  { key: 'focusPaneDownKey', label: 'Focus pane down' }
]

/** The settings categories, shown in the left sidebar in this order. */
type CategoryId = 'general' | 'keybindings' | 'updates'

interface CategoryDef {
  readonly id: CategoryId
  readonly label: string
}

const CATEGORIES: ReadonlyArray<CategoryDef> = [
  { id: 'general', label: 'General' },
  { id: 'keybindings', label: 'Key Bindings' },
  { id: 'updates', label: 'Check for updates' }
]

export function SettingsModal({ onClose }: SettingsModalProps): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const hydrate = useStore((s) => s.hydrate)
  const updateStatus = useStore((s) => s.updateStatus)
  const updateChecking = useStore((s) => s.updateChecking)
  const checkForUpdates = useStore((s) => s.checkForUpdates)
  const openRestartConfirm = useStore((s) => s.openRestartConfirm)
  const [location, setLocation] = useState(settings.worktree.location)
  const [shell, setShell] = useState(settings.terminal.shell ?? '')
  // State detection defaults ON; only an explicit `false` opts out (§9).
  const [stateDetection, setStateDetection] = useState(settings.terminal.stateDetection !== false)
  // Status-change notifications default ON; only an explicit `false` opts out (§9.5).
  const [statusNotifications, setStatusNotifications] = useState(
    settings.terminal.statusChangeNotifications !== false
  )
  // Current value of every configurable chord, keyed by its settings field.
  const [chords, setChords] = useState<Record<ChordKey, string>>(() => {
    const defaults = defaultKeybindings(rendererOs())
    return CHORD_FIELDS.reduce(
      (acc, f) => {
        acc[f.key] = settings[f.key] ?? defaults[f.key]
        return acc
      },
      {} as Record<ChordKey, string>
    )
  })
  // Which chord field is currently capturing (null → none).
  const [capturing, setCapturing] = useState<ChordKey | null>(null)
  // The modifiers held so far during the active capture (live preview), e.g. `Ctrl+Shift`.
  const [preview, setPreview] = useState('')
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The category whose panel is shown. Edits persist across switches (all field
  // state lives above), so this only chooses what's visible — never what's saved.
  const [category, setCategory] = useState<CategoryId>(
    () => useStore.getState().settingsInitialTab ?? 'general'
  )

  // The Jira API key (DESIGN §13.7, I16): a SEPARATE save flow from the rest of this
  // form. It never joins `settings`/`SettingsPatchDTO` —
  // the key must never reach `app.updateSettings` (settings.json) or the store, only
  // the encrypted-at-rest `credentials` port. The field always starts empty; we only
  // ever learn whether a key is CURRENTLY stored, never its value.
  const [hasJiraKey, setHasJiraKey] = useState(false)
  const [jiraKeyInput, setJiraKeyInput] = useState('')
  const [jiraKeyBusy, setJiraKeyBusy] = useState(false)
  const [jiraKeyError, setJiraKeyError] = useState<string | null>(null)

  useEffect(() => {
    void window.octopusAPI.credentials.hasJiraKey().then(setHasJiraKey)
  }, [])

  // Store (`key`) or clear (`null`) the Jira key. Resolves true on success; on any
  // failure — a rejected ack OR a rejected promise (m10) — shows the error inline and
  // resolves false. `busy` always resets.
  const writeJiraKey = async (key: string | null): Promise<boolean> => {
    setJiraKeyBusy(true)
    setJiraKeyError(null)
    try {
      const ack = await window.octopusAPI.credentials.setJiraKey({ key })
      if (!ack.ok) {
        setJiraKeyError(ack.error ?? 'secure storage unavailable')
        return false
      }
      setJiraKeyInput('')
      setHasJiraKey(key !== null)
      return true
    } catch {
      setJiraKeyError('secure storage unavailable')
      return false
    } finally {
      setJiraKeyBusy(false)
    }
  }

  const saveJiraKey = (): void => {
    const key = jiraKeyInput.trim()
    if (key === '') return
    void writeJiraKey(key)
  }

  const clearJiraKey = (): void => {
    void writeJiraKey(null)
  }

  // Name of the action already bound to `chord`, or null if free. Checks the fixed
  // shortcuts (`RESERVED_CHORDS`) and every OTHER configurable chord, so two actions
  // can never fire on one keypress (§5.4).
  const conflictLabel = (chord: string, target: ChordKey): string | null => {
    const reserved = RESERVED_CHORDS.find((r) => r.chord === chord)
    if (reserved) return reserved.label
    const other = CHORD_FIELDS.find((f) => f.key !== target && chords[f.key] === chord)
    return other ? other.label : null
  }

  // Capture a chord for one field, building it live as keys go down. A modifier-only
  // keydown (Ctrl/Shift/…) is NOT a complete chord — it just updates the preview so the
  // user sees the chord forming and can keep adding keys. The chord commits on the first
  // NON-modifier key (any key — letter, digit, arrow, e.g. `Ctrl+Shift+T`) while ≥1
  // modifier is held (§5.4) — the modifier keeps it off bare terminal keystrokes. A bare
  // (modifier-less) final key is rejected inline, and a chord already owned by another
  // action surfaces a conflict. Fields are independent. `onKeyUp` keeps the preview in
  // sync as modifiers are released.
  const captureChord = (target: ChordKey, e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (isModifierCode(e.nativeEvent.code)) {
      setPreview(modifierPrefix(e.nativeEvent))
      setSwitchError(null)
      return
    }
    if (!hasModifier(e.nativeEvent)) {
      setSwitchError(modifierRequiredHint())
      return
    }
    const chord = parseChord(e.nativeEvent)
    const owner = conflictLabel(chord, target)
    setChords((prev) => ({ ...prev, [target]: chord }))
    setSwitchError(owner ? `Already used by ${owner}` : null)
    setPreview('')
    setCapturing(null)
  }

  // While capturing, releasing a modifier must shrink the preview to match. The final
  // key's keyup is ignored because `captureChord` already cleared `capturing`.
  const trackRelease = (e: React.KeyboardEvent): void => {
    setPreview(modifierPrefix(e.nativeEvent))
  }

  // Start capturing for one field: arm it and clear any prior preview/error.
  const startCapture = (target: ChordKey): void => {
    setCapturing(target)
    setPreview('')
    setSwitchError(null)
  }

  // Save is blocked only while a COMMITTED chord collides (a format-rejected capture
  // never commits, so it can't yield an invalid saved value — and letting it block
  // Save would strand the dialog once the inline error scrolls out of view). Every
  // field is re-checked so a collision is caught from either side.
  const conflicts: Record<ChordKey, string | null> = CHORD_FIELDS.reduce(
    (acc, f) => {
      acc[f.key] = conflictLabel(chords[f.key], f.key)
      return acc
    },
    {} as Record<ChordKey, string | null>
  )
  const saveBlocked = CHORD_FIELDS.some((f) => conflicts[f.key] !== null)

  const save = async (): Promise<void> => {
    if (saveBlocked) return
    setBusy(true)
    setError(null)
    // A typed-but-unsaved Jira key is saved too (H2) — the footer Save is the obvious
    // first-time path. On failure the modal stays open with the key's inline error.
    const typedKey = jiraKeyInput.trim()
    if (typedKey !== '' && !(await writeJiraKey(typedKey))) {
      setBusy(false)
      // The key's own error renders in the General tab; this one is visible from any tab.
      setError('Failed to save the Jira API key (see General)')
      return
    }
    const patch: SettingsPatchDTO = {
      worktree: { location: location.trim() },
      terminal: {
        shell: shell.trim() || undefined,
        stateDetection,
        statusChangeNotifications: statusNotifications
      },
      sessionNextKey: chords.sessionNextKey,
      sessionPrevKey: chords.sessionPrevKey,
      taskNextKey: chords.taskNextKey,
      taskPrevKey: chords.taskPrevKey,
      newSessionKey: chords.newSessionKey,
      newTaskKey: chords.newTaskKey,
      closeSessionKey: chords.closeSessionKey,
      searchKey: chords.searchKey,
      copyKey: chords.copyKey,
      pasteKey: chords.pasteKey,
      issuesKey: chords.issuesKey,
      splitRightKey: chords.splitRightKey,
      splitDownKey: chords.splitDownKey,
      focusPaneLeftKey: chords.focusPaneLeftKey,
      focusPaneRightKey: chords.focusPaneRightKey,
      focusPaneUpKey: chords.focusPaneUpKey,
      focusPaneDownKey: chords.focusPaneDownKey
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

  // The scrollable content pane for the active category. A fixed height keeps the
  // dialog from resizing as categories with different field counts swap in.
  const pane: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    height: 320,
    overflowY: 'auto',
    paddingRight: 4
  }

  // A keybinding row: the action label on the left, its chord button on the right.
  const chordRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  }

  return (
    <div role="presentation" onClick={onClose} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) onClose()
        }}
        style={{ ...modalCardStyle, width: 640 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Settings</h2>

        <div style={{ display: 'flex', gap: 16, minHeight: 0 }}>
          {/* Category sidebar — clicking swaps the content pane; edits are retained. */}
          <nav
            aria-label="Settings categories"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              width: 160,
              flexShrink: 0,
              borderRight: `1px solid ${color.border}`,
              paddingRight: 12
            }}
          >
            {CATEGORIES.map((c) => {
              const selected = category === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  className="settings-cat"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setCategory(c.id)}
                  style={{
                    textAlign: 'left',
                    padding: '7px 10px',
                    border: '1px solid transparent',
                    borderRadius: radius.sm,
                    background: selected ? color.bgSelected : 'transparent',
                    color: selected ? color.text : color.textSecondary,
                    boxShadow: selected ? `inset 2px 0 0 ${color.accent}` : 'none',
                    fontWeight: selected ? 500 : 400,
                    cursor: 'pointer'
                  }}
                >
                  {c.label}
                </button>
              )
            })}
          </nav>

          {/* Content pane for the active category. */}
          {category === 'general' ? (
            <div style={pane} role="tabpanel" aria-label="General">
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

              <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  aria-label="session state detection"
                  checked={stateDetection}
                  disabled={busy}
                  onChange={(e) => setStateDetection(e.target.checked)}
                />
                <span>
                  Detect session status (Working / Idle / Needs input)
                  <span style={{ display: 'block', color: color.muted, fontSize: fontSize.sm }}>
                    Applies to newly-created sessions.
                  </span>
                </span>
              </label>

              <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  aria-label="status change notifications"
                  checked={statusNotifications}
                  disabled={busy}
                  onChange={(e) => setStatusNotifications(e.target.checked)}
                />
                <span>
                  Enable status changes notifications
                  <span style={{ display: 'block', color: color.muted, fontSize: fontSize.sm }}>
                    Pops a notification in the active window when a session status changes.
                  </span>
                </span>
              </label>

              {/* The Jira API key (DESIGN §13.7, I16): a separate save/clear flow that
                  never touches `app.updateSettings` or this form's own Save — see the
                  state comment above for why. The field never shows the stored key; it
                  only ever starts empty and reports whether one is currently saved. */}
              <div style={{ ...field, gap: 8 }}>
                <span style={{ color: color.text }}>Jira API key</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="password"
                    aria-label="jira api key"
                    autoComplete="off"
                    value={jiraKeyInput}
                    placeholder={hasJiraKey ? 'Key saved' : 'Paste your LiteLLM API key'}
                    disabled={jiraKeyBusy}
                    onChange={(e) => setJiraKeyInput(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    aria-label="save jira api key"
                    disabled={jiraKeyBusy || jiraKeyInput.trim() === ''}
                    onClick={saveJiraKey}
                  >
                    Save
                  </button>
                  {hasJiraKey ? (
                    <button
                      type="button"
                      aria-label="clear jira api key"
                      disabled={jiraKeyBusy}
                      onClick={clearJiraKey}
                    >
                      Clear key
                    </button>
                  ) : null}
                </div>
                {jiraKeyError ? (
                  <span role="alert" style={{ color: color.errorText }}>
                    {jiraKeyError}
                  </span>
                ) : null}
              </div>
            </div>
          ) : category === 'updates' ? (
            <div style={pane} role="tabpanel" aria-label="Check for updates">
              <div>Installed version: {updateStatus?.currentVersion ?? 'unknown'}</div>
              {updateStatus?.availableVersion ? (
                <div>Available version: {updateStatus.availableVersion}</div>
              ) : null}
              <div style={{ color: color.textSecondary, fontSize: fontSize.sm }}>
                {updateStatus?.lastCheckedAt !== undefined
                  ? `Last checked ${new Date(updateStatus.lastCheckedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false
                    })}`
                  : 'Not checked yet'}
              </div>
              {updateStatus?.state === 'upToDate' ? <div>Octopus is up to date.</div> : null}
              {updateStatus?.state === 'available' ? (
                <div>Version {updateStatus.availableVersion} is available.</div>
              ) : null}
              {updateStatus?.state === 'unreachable' ? (
                <div role="alert" style={{ color: color.errorText }}>
                  Couldn&apos;t check: update folder unreachable.
                  {updateStatus.availableVersion
                    ? ' The version above was found earlier and can’t be installed until the folder is reachable.'
                    : null}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  disabled={updateChecking}
                  onClick={(e) => {
                    // Focus the card before the button disables (else focus drops to <body>).
                    e.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus()
                    void checkForUpdates()
                  }}
                >
                  {updateChecking ? 'Checking…' : 'Check now'}
                </button>
                {updateStatus?.availableVersion ? (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={updateStatus.state === 'unreachable'}
                    title={
                      updateStatus.state === 'unreachable'
                        ? 'The update folder is unreachable'
                        : undefined
                    }
                    onClick={() => openRestartConfirm(updateStatus.availableVersion as string)}
                  >
                    Install
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div style={pane} role="tabpanel" aria-label="Key Bindings">
              {CHORD_FIELDS.map((f) => {
                const active = capturing === f.key
                return (
                  <label key={f.key} style={field}>
                    <span style={chordRow}>
                      <span>{f.label} shortcut</span>
                      <button
                        type="button"
                        aria-label={`${f.label.toLowerCase()} shortcut`}
                        disabled={busy}
                        onClick={() => startCapture(f.key)}
                        onBlur={() => {
                          if (active) {
                            setCapturing(null)
                            setPreview('')
                          }
                        }}
                        onKeyDown={active ? (e) => captureChord(f.key, e) : undefined}
                        onKeyUp={active ? trackRelease : undefined}
                      >
                        {active
                          ? preview
                            ? modifierPreviewLabel(preview)
                            : 'Press a shortcut…'
                          : chordLabel(chords[f.key])}
                      </button>
                    </span>
                    {active && switchError ? (
                      <span role="alert" style={{ color: color.errorText }}>
                        {switchError}
                      </span>
                    ) : conflicts[f.key] ? (
                      <span role="alert" style={{ color: color.errorText }}>
                        Already used by {conflicts[f.key]}
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>
          )}
        </div>

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
            onClick={() => void save()}
            disabled={busy || saveBlocked}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
