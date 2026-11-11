/**
 * In-band markers on restored history (DESIGN §6.6). Private OSCs, so a terminal that
 * doesn't look for them ignores them; only the pane's writer
 * (`renderer/src/terminal/restored-history-writer.ts`) acts on them.
 *
 *  - Size: the scrollback store records the PTY size in the saved stream, ahead of the
 *    output written at it. Replay parses each stretch at its recorded size and xterm then
 *    reflows to the pane, like a live terminal on resize. Parsed at another width,
 *    a TUI's absolute column moves (`CSI n G`) and line padding scramble its frame.
 *  - End: main writes it after painted history. The writer refits the pane there and
 *    puts what follows below the old content.
 *
 * The application layer, which writes the end marker, may not import `shared`, so it
 * declares the same literal (`application/use-cases/sanitize-restored-history.ts`);
 * `src/main/restored-history-marker.test.ts` keeps the two equal.
 */

/** Common prefix of every marker; the body runs to the next BEL. */
export const HISTORY_MARKER_PREFIX = '\x1b]7764;octopus-'

export const RESTORED_HISTORY_END = `${HISTORY_MARKER_PREFIX}history-end\x07`

/** The marker recording that the output after it was written at `cols`×`rows`. */
export function historySizeMarker(cols: number, rows: number): string {
  return `${HISTORY_MARKER_PREFIX}size=${cols}x${rows}\x07`
}

export type HistoryMarker =
  { readonly kind: 'end' } | { readonly kind: 'size'; readonly cols: number; readonly rows: number }

/** Parse a marker body (between the prefix and the BEL); undefined if unknown. */
export function parseHistoryMarker(body: string): HistoryMarker | undefined {
  if (body === 'history-end') return { kind: 'end' }
  const m = /^size=(\d{1,4})x(\d{1,4})$/.exec(body)
  if (!m) return undefined
  const cols = Number(m[1])
  const rows = Number(m[2])
  return cols > 0 && rows > 0 ? { kind: 'size', cols, rows } : undefined
}
