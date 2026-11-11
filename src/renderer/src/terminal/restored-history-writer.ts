/**
 * The pane's output writer: `term.write`, plus the markers of restored history
 * (`shared/restored-history.ts`, DESIGN §6.6).
 *
 * Restored history is the raw output of a dead PTY, so it must be parsed the way the
 * terminal that recorded it did:
 *  - Size marker: xterm is sized to the recorded size before the output that follows.
 *    A TUI (Claude Code) lays out its frame for the PTY width, with absolute column
 *    moves and padded lines; parsed at another width the frame scrambles. Pane refits
 *    are held off meanwhile (`replaying`).
 *  - End marker: the pane is refit (xterm reflows the history, as a live terminal does
 *    on resize). Then, since a TUI killed mid-frame leaves the cursor hidden and parked
 *    inside its frame (Claude keeps it in the input box) or on the alternate screen:
 *      1. leave the alternate screen (`?1049l`, which restores the normal-screen cursor);
 *      2. soft-reset (DECSTR: cursor visible, full scroll region, default modes/charset;
 *         it does not move the cursor);
 *      3. move the cursor down to the last non-blank line, so the "session restored"
 *         separator and the new shell start below the old content.
 *    The refit runs with the cursor on a fresh row below that content: xterm never
 *    reflows the cursor's row.
 * Each marker is handled once xterm has parsed everything before it; output arriving
 * meanwhile is held, so order is kept.
 */
import type { Terminal } from '@xterm/xterm'
import {
  HISTORY_MARKER_PREFIX,
  RESTORED_HISTORY_END,
  parseHistoryMarker
} from '../../../shared/restored-history'

/** `CSI n B` from the cursor down to the last non-blank row of the screen; '' if none. */
function cursorToContentEnd(term: Terminal): string {
  const buffer = term.buffer.active
  const cursor = buffer.baseY + buffer.cursorY
  let last = buffer.length - 1
  while (last > cursor && !buffer.getLine(last)?.translateToString(true).trim()) {
    last--
  }
  // Rows below the cursor are on the screen, so the move never clamps (DECSTR reset the
  // scroll region first).
  return last > cursor ? `\x1b[${last - cursor}B` : ''
}

export interface TerminalWriter {
  write(data: string): void
  /** Between a size marker and the end marker: the pane must not refit. */
  replaying(): boolean
}

/** `refit` fits xterm to the pane (and resizes the PTY); called at the end marker. */
export function createTerminalWriter(term: Terminal, refit: () => void): TerminalWriter {
  let held: string[] | null = null
  let replaying = false

  const write = (data: string): void => {
    if (held) {
      held.push(data)
      return
    }
    const at = data.indexOf(HISTORY_MARKER_PREFIX)
    const close = at < 0 ? -1 : data.indexOf('\x07', at)
    if (close < 0) {
      term.write(data)
      return
    }
    const marker = parseHistoryMarker(data.slice(at + HISTORY_MARKER_PREFIX.length, close))
    const after = data.slice(close + 1)
    const pending: string[] = (held = [])
    const resume = (next: string): void => {
      held = null
      for (const chunk of [next, ...pending]) write(chunk)
    }
    term.write(data.slice(0, at), () => {
      if (marker?.kind === 'size') {
        replaying = true
        term.resize(marker.cols, marker.rows)
        resume(after)
      } else if (marker?.kind !== 'end') {
        resume(after)
      } else if (term.buffer.active.type === 'alternate') {
        resume(`\x1b[?1049l${RESTORED_HISTORY_END}${after}`) // handle the end on the normal screen
      } else {
        // Park the cursor on a fresh row below the old content for the refit: xterm
        // never reflows the cursor's row. Then step back onto the last content row, so
        // what follows (the separator's `\r\n`) starts right under it.
        term.write(`\x1b[!p${cursorToContentEnd(term)}\r\n`, () => {
          replaying = false
          refit()
          resume(`\x1b[A${after}`)
        })
      }
    })
  }
  return { write, replaying: () => replaying }
}
