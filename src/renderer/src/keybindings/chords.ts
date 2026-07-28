/**
 * Keyboard-chord helpers shared by the shortcut hook, the terminal pane, and the
 * settings dialog (DESIGN §5.4). A "chord" is a canonical string built from the
 * active modifiers (fixed order `Ctrl+Alt+Shift+Meta`) plus the layout-independent
 * `KeyboardEvent.code`, e.g. `"Ctrl+Shift+ArrowRight"` or `"Alt+KeyK"`.
 *
 * The two session-switch bindings are user-configurable to ANY chord (any key with
 * at least one modifier — see `hasModifier`). `parseChord` produces the stored form,
 * `matchesChord` compares a live event to it, and `chordLabel` renders it for the UI.
 *
 * `RESERVED_CHORDS` lists the fixed shortcuts the hook owns; the settings dialog uses
 * it to block a user binding that collides with one. It MUST mirror the fixed `switch`
 * cases in `useKeyboardShortcuts.ts` — keep the two in sync.
 */

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

/** Human-readable label for a stored chord, e.g. `Ctrl+Shift+→` or `Alt+K`. */
export function chordLabel(chord: string): string {
  if (!chord) return ''
  const parts = chord.split('+')
  const code = parts.pop() as string
  return [...parts, codeLabel(code)].join('+')
}

/** A fixed shortcut the hook owns, for conflict detection in settings. */
export interface ReservedChord {
  readonly chord: string
  readonly label: string
}

/**
 * The fixed Ctrl+Shift shortcuts (§5.4). MUST mirror the `switch (e.code)` cases in
 * `useKeyboardShortcuts.ts` — if a binding is added/changed there, update this list.
 */
export const RESERVED_CHORDS: ReadonlyArray<ReservedChord> = [
  { chord: 'Ctrl+Shift+BracketRight', label: 'Next task' },
  { chord: 'Ctrl+Shift+BracketLeft', label: 'Previous task' },
  { chord: 'Ctrl+Shift+Tab', label: 'Cycle sessions' },
  { chord: 'Ctrl+Shift+KeyT', label: 'New terminal' },
  { chord: 'Ctrl+Shift+KeyN', label: 'New task' },
  { chord: 'Ctrl+Shift+KeyW', label: 'Close session' },
  { chord: 'Ctrl+Shift+KeyF', label: 'Terminal search' }
]
