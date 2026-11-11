/**
 * Make restored scrollback safe to replay into a fresh xterm.js terminal.
 *
 * Restored scrollback (DESIGN §6.6, I13) is stale display metadata: raw bytes from a
 * previous, now-dead PTY that we replay purely for the user to read. Those bytes can
 * make xterm send input back into the freshly-spawned shell — which echoes it as
 * garbage — in two ways, both neutralized here:
 *
 *  1. Query *requests* (Device Attributes, cursor-position reports, OSC color queries).
 *     xterm answers each one it parses by firing `onData` (e.g. `0;276;0c`, `11;rgb:…`).
 *     These are one-shot, so we strip the requests. Reply forms and OSC color *set*
 *     sequences (no `?`) are preserved.
 *  2. Input-reporting DEC private *modes* left enabled (focus reporting `?1004`, mouse
 *     tracking `?1000/1002/1003/…`, bracketed paste `?2004`). These are not one-shot: a
 *     stale enable puts xterm into a state where it emits input on every focus change,
 *     mouse event or paste (the `^[[I` focus-in report is the visible symptom). We append
 *     an explicit reset of these modes after the history, returning xterm to its default
 *     baseline; the live shell re-enables whatever it actually uses.
 *
 * Live PTY output is never passed through here, so a running program's real queries and
 * mode changes keep working normally.
 */

/**
 * DEC private modes that make xterm send bytes to the PTY on UI events (focus, mouse,
 * paste). Reset after replayed history so a stale enable can't leak input into the fresh
 * shell. Ordered focus → mouse tracking → mouse encoding → bracketed paste.
 */
const INPUT_REPORTING_MODES = [
  1004, // focus reporting (emits CSI I / CSI O on focus change — the `^[[I` symptom)
  1000, // mouse: normal tracking
  1001, // mouse: highlight tracking
  1002, // mouse: button-event tracking
  1003, // mouse: any-event tracking
  1005, // mouse: UTF-8 extended coordinates
  1006, // mouse: SGR extended coordinates
  1015, // mouse: urxvt extended coordinates
  1016, // mouse: SGR-pixel coordinates
  2004 // bracketed paste
]

/**
 * In-band end-of-history marker, written after painted history. The pane's writer
 * (`renderer/src/terminal/restored-history-writer.ts`) replaces it with a display reset
 * and moves the cursor below the old content: only the terminal knows where that ends.
 * Mirrors `shared/restored-history.ts`, which this layer may not import (kept equal by
 * `main/restored-history-marker.test.ts`).
 */
export const RESTORED_HISTORY_END = '\x1b]7764;octopus-history-end\x07'

/** `CSI ? m ; … l` resetting every input-reporting mode in one DECRST. */
const RESET_INPUT_MODES = `\x1b[?${INPUT_REPORTING_MODES.join(';')}l`

// Matching the ESC (\x1b) / BEL (\x07) / ST control bytes IS this module's job — the
// no-control-regex lint is a false positive for every pattern below.
/* eslint-disable no-control-regex */
export function sanitizeRestoredHistory(data: string): string {
  const stripped = data
    // Primary DA (DA1) request `CSI Ps c`. The reply `CSI ? … c` has `?` outside the
    // class, so it is left intact.
    .replace(/\x1b\[[0-9;]*c/g, '')
    // Secondary DA (DA2) request `CSI > Ps c`.
    .replace(/\x1b\[>[0-9;]*c/g, '')
    // Tertiary DA (DA3) request `CSI = Ps c`.
    .replace(/\x1b\[=[0-9;]*c/g, '')
    // Device Status Report `CSI Ps n` / cursor-position `CSI 6 n` (incl. DEC private `?`).
    .replace(/\x1b\[\??[0-9;]*n/g, '')
    // XTVERSION request `CSI > Ps q` (the `>` leaves DECSCUSR `CSI Ps SP q` alone).
    .replace(/\x1b\[>[0-9;]*q/g, '')
    // DECRQM request-mode `CSI Ps $ p` (ANSI and DEC private `?`).
    .replace(/\x1b\[\??[0-9;]*\$p/g, '')
    // OSC color queries: fg/bg/cursor (`10|11|12`) and palette (`4;n`), only when a `?`
    // is present, terminated by BEL or ST. Set forms (no `?`) are preserved.
    .replace(/\x1b\](?:1[012]|4;[0-9]+);[^\x07\x1b]*\?[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

  // Return xterm to a clean input-mode baseline once the (now query-free) history has
  // painted, so no mode left enabled by the stale bytes emits input into the live shell.
  return stripped + RESET_INPUT_MODES
}
/* eslint-enable no-control-regex */
