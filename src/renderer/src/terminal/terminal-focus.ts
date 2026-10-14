/**
 * A tiny registry mapping a session id → a function that focuses that terminal
 * (DESIGN §5.4). Mirrors `terminal-search.ts`'s opener registry: each mounted
 * `TerminalPane` registers itself, and a caller that needs to hand focus back to
 * "the active terminal" without holding a ref to it — the Issues drawer's
 * close-restore chain (`IssuesDrawer`) — resolves the active session and
 * calls `focusTerminal(id)`.
 *
 * Kept out of the store for the same reason as the search registry: focusing a
 * pane is transient per-pane UI, not workspace state.
 */

type Focuser = () => void

const focusers = new Map<string, Focuser>()

/** Register a pane's focuser. Replaces any prior one for the session. */
export function registerTerminalFocuser(sessionId: string, focus: Focuser): void {
  focusers.set(sessionId, focus)
}

/** Remove a pane's focuser (on unmount). Idempotent. */
export function unregisterTerminalFocuser(sessionId: string): void {
  focusers.delete(sessionId)
}

/** Focus the terminal for `sessionId` if a pane is registered. No-op otherwise. */
export function focusTerminal(sessionId: string): void {
  focusers.get(sessionId)?.()
}

/** Test seam: drop all focusers. */
export function _resetTerminalFocusers(): void {
  focusers.clear()
}
