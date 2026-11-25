/**
 * Keyboard-chord helpers shared by the shortcut hook, the terminal pane, and the
 * settings dialog (DESIGN §5.4). A "chord" is a canonical string built from the
 * active modifiers (fixed order `Ctrl+Alt+Shift+Meta`) plus the layout-independent
 * `KeyboardEvent.code`, e.g. `"Ctrl+Shift+ArrowRight"` or `"Alt+KeyK"`.
 *
 * Every shortcut is user-configurable to ANY chord (any key with at least one
 * modifier — see `hasModifier`): next/previous session, next/previous task, new
 * session, new task, close session, and terminal search. `parseChord` produces the
 * stored form, `matchesChord` compares a live event to it, and `chordLabel` renders
 * it for the UI.
 *
 * `RESERVED_CHORDS` lists any shortcuts the hook owns as FIXED (currently none); the
 * settings dialog checks it to block a user binding that would collide with one. It
 * is the seam where a future fixed shortcut would be declared and MUST mirror any
 * fixed `switch` cases in `useKeyboardShortcuts.ts` — keep the two in sync.
 */

import { getPlatform } from '../platform'

/** True if the event carries at least one modifier — required for a bindable chord. */
export function hasModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.altKey || e.shiftKey || e.metaKey
}

/** The eight modifier key codes — a keydown for one of these is not a complete chord. */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight'
])

/** True iff `code` is a modifier key itself (so a keydown for it must not commit a chord). */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

/** The held modifiers in canonical order, e.g. `"Ctrl+Shift"`; `""` when none are held. */
export function modifierPrefix(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  return parts.join('+')
}

/** Canonical chord string for an event: modifiers in fixed order + `e.code`. */
export function parseChord(e: KeyboardEvent): string {
  const prefix = modifierPrefix(e)
  return prefix ? `${prefix}+${e.code}` : e.code
}

/** True iff `e` is a keydown whose canonical chord equals `chord` (false if unset). */
export function matchesChord(e: KeyboardEvent, chord?: string): boolean {
  if (!chord) return false
  return parseChord(e) === chord
}

const CODE_GLYPH: Readonly<Record<string, string>> = {
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
  BracketRight: ']',
  BracketLeft: '['
}

/** Friendly display for a single `KeyboardEvent.code`. */
function codeLabel(code: string): string {
  if (code in CODE_GLYPH) return CODE_GLYPH[code]
  if (code.startsWith('Key')) return code.slice(3) // KeyK → K
  if (code.startsWith('Digit')) return code.slice(5) // Digit1 → 1
  return code // Tab, Escape, F5, … as-is
}

/** macOS modifier glyphs. The canonical order Ctrl, Alt, Shift, Meta is Apple's ⌃⌥⇧⌘. */
const MAC_MODIFIER_GLYPH: Readonly<Record<string, string>> = {
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Meta: '⌘'
}

/**
 * Human-readable label for a stored chord, e.g. `Ctrl+Shift+→` or `Alt+K`. On macOS
 * it uses the native glyphs with no separators (`⇧⌘→`, `⌥K`).
 */
export function chordLabel(chord: string, platform: string = getPlatform()): string {
  if (!chord) return ''
  const parts = chord.split('+')
  const code = parts.pop() as string
  if (platform === 'darwin') {
    return parts.map((m) => MAC_MODIFIER_GLYPH[m] ?? m).join('') + codeLabel(code)
  }
  return [...parts, codeLabel(code)].join('+')
}

/**
 * Label for a partial chord while modifiers are held during capture (`modifierPrefix`
 * output): `Ctrl+Shift+…` on Linux, `⇧⌘…` on macOS.
 */
export function modifierPreviewLabel(prefix: string, platform: string = getPlatform()): string {
  if (platform === 'darwin') {
    return (
      prefix
        .split('+')
        .map((m) => MAC_MODIFIER_GLYPH[m] ?? m)
        .join('') + '…'
    )
  }
  return `${prefix}+…`
}

/** The "a chord needs a modifier" hint for the capture field. */
export function modifierRequiredHint(platform: string = getPlatform()): string {
  return platform === 'darwin'
    ? 'Add at least one modifier (⌘ / ⌃ / ⌥ / ⇧)'
    : 'Add at least one modifier (Ctrl / Alt / Shift)'
}

/** A fixed shortcut the hook owns, for conflict detection in settings. */
export interface ReservedChord {
  readonly chord: string
  readonly label: string
}

/**
 * Fixed shortcuts the hook owns (§5.4). Currently EMPTY — every action is
 * user-configurable and collision-checked among the configured chords by the
 * settings dialog. Kept as the seam for any future fixed binding; if one is added,
 * it MUST mirror a `switch (e.code)` case in `useKeyboardShortcuts.ts`.
 */
export const RESERVED_CHORDS: ReadonlyArray<ReservedChord> = []
