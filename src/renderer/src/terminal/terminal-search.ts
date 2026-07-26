/**
 * A tiny registry mapping a session id → a function that opens that terminal's
 * in-pane search box (DESIGN §5.4, `Ctrl+Shift+F`). It mirrors the pty-router sink
 * pattern: each mounted `TerminalPane` registers its opener; the global keyboard
 * shortcut resolves the active session and calls `openSearch(id)`.
 *
 * Keeping this out of the store is deliberate — opening a search box is transient
 * per-pane UI, not workspace state, so it never needs to round-trip the reducer.
 */

type SearchOpener = () => void

const openers = new Map<string, SearchOpener>()

/** Register a pane's search-opener. Replaces any prior one for the session. */
export function registerSearchOpener(sessionId: string, open: SearchOpener): void {
  openers.set(sessionId, open)
}

/** Remove a pane's search-opener (on unmount). Idempotent. */
export function unregisterSearchOpener(sessionId: string): void {
  openers.delete(sessionId)
}

/** Open the search box for `sessionId` if a pane is registered. No-op otherwise. */
export function openSearch(sessionId: string): void {
  openers.get(sessionId)?.()
}

/** Test seam: drop all openers. */
export function _resetSearchOpeners(): void {
  openers.clear()
}
