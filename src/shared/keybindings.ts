/**
 * Platform-aware default keyboard chords (DESIGN §5.4). Pure and process-agnostic
 * (no Node / DOM imports), so the settings adapter (main), the renderer store and the
 * Settings dialog all derive their defaults from this ONE table instead of keeping
 * three hand-synced copies.
 *
 * Chord strings use the canonical form of `renderer/src/keybindings/chords.ts`:
 * modifiers in the fixed order `Ctrl+Alt+Shift+Meta`, then `KeyboardEvent.code`. So
 * a macOS "Cmd+Shift+N" is stored as `Shift+Meta+KeyN` (NOT `Meta+Shift+KeyN`, which
 * `matchesChord` would never match).
 *
 * Non-darwin platforms get exactly the historical Linux strings (byte-identical: they
 * are what existing settings.json files and the Linux tests carry). On darwin the
 * primary modifier is Cmd (`Meta`), which leaves Ctrl chords free for the shell, and
 * copy/paste are the native `Cmd+C` / `Cmd+V`. None of the darwin defaults are macOS
 * system chords (Cmd+Q/W/H/M/Tab/`/Space/,, Cmd+Shift+3/4/5/Q//), and Toggle Issues
 * (`Cmd+Shift+I`) does not collide with the devtools chord `Cmd+Alt+I`.
 */

/** `process.platform`-style platform id (`'linux'`, `'darwin'`, `'win32'`, …). */
export type PlatformId = string

/** The settings keys that hold a configurable chord. */
export type KeybindingKey =
  | 'sessionNextKey'
  | 'sessionPrevKey'
  | 'taskNextKey'
  | 'taskPrevKey'
  | 'newSessionKey'
  | 'newTaskKey'
  | 'closeSessionKey'
  | 'searchKey'
  | 'copyKey'
  | 'pasteKey'
  | 'issuesKey'
  | 'splitRightKey'
  | 'splitDownKey'
  | 'focusPaneLeftKey'
  | 'focusPaneRightKey'
  | 'focusPaneUpKey'
  | 'focusPaneDownKey'

export type Keybindings = { readonly [K in KeybindingKey]: string }

export function isDarwin(platform: PlatformId): boolean {
  return platform === 'darwin'
}

/** The modifier app chords are built on: `Meta` (Cmd) on macOS, `Ctrl` elsewhere. */
export function primaryModifier(platform: PlatformId): 'Meta' | 'Ctrl' {
  return isDarwin(platform) ? 'Meta' : 'Ctrl'
}

/** Canonical `<primary>+Shift+<code>` chord (`Ctrl+Shift+X` / `Shift+Meta+X`). */
function primaryShift(platform: PlatformId, code: string): string {
  return isDarwin(platform) ? `Shift+Meta+${code}` : `Ctrl+Shift+${code}`
}

/** The default chord for every configurable binding on `platform`. */
export function defaultKeybindings(platform: PlatformId): Keybindings {
  const mac = isDarwin(platform)
  const ps = (code: string): string => primaryShift(platform, code)
  return {
    sessionNextKey: ps('ArrowRight'),
    sessionPrevKey: ps('ArrowLeft'),
    taskNextKey: ps('ArrowDown'),
    taskPrevKey: ps('ArrowUp'),
    newSessionKey: ps('KeyN'),
    newTaskKey: ps('KeyT'),
    closeSessionKey: ps('KeyW'),
    searchKey: ps('KeyF'),
    copyKey: mac ? 'Meta+KeyC' : 'Ctrl+Shift+KeyC',
    pasteKey: mac ? 'Meta+KeyV' : 'Ctrl+Shift+KeyV',
    issuesKey: mac ? 'Shift+Meta+KeyI' : 'Alt+Shift+KeyI',
    // Split panes (DESIGN §5.7).
    splitRightKey: ps('KeyE'),
    splitDownKey: ps('KeyO'),
    focusPaneLeftKey: ps('KeyH'),
    focusPaneRightKey: ps('KeyL'),
    focusPaneUpKey: ps('KeyK'),
    focusPaneDownKey: ps('KeyJ')
  }
}

/** The fixed state-detection debug-overlay chord (§11): `Ctrl+Shift+D` / `Cmd+Shift+D`. */
export function debugOverlayChord(platform: PlatformId): string {
  return primaryShift(platform, 'KeyD')
}
