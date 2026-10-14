/**
 * A tiny registry mapping a session id → a function that measures that session's
 * `TerminalPane` host container and current cell size (DESIGN §5.7 Split panes). It
 * mirrors the `terminal-search.ts` opener registry: each mounted `TerminalPane`
 * registers its measurer on mount and unregisters on unmount.
 *
 * The split chord (`useKeyboardShortcuts`) feeds the result into `canSplit` (`store/split-layout.ts`) to
 * refuse a split that would leave either half under the minimum pane size, before
 * it ever asks the backend to create a new session.
 *
 * Kept out of the store for the same reason as `terminal-search.ts`: this is
 * transient per-pane DOM measurement, not workspace state that needs to round-trip
 * the reducer.
 */

/** A pane's measured container size and derived terminal cell size, in CSS pixels. */
export interface PaneMetrics {
  readonly widthPx: number
  readonly heightPx: number
  readonly cellWidthPx: number
  readonly cellHeightPx: number
}

type Measure = () => PaneMetrics | undefined

const measurers = new Map<string, Measure>()

/** Register a pane's metrics reader. Replaces any prior one for the session. */
export function registerPaneMetrics(sessionId: string, measure: Measure): void {
  measurers.set(sessionId, measure)
}

/** Remove a pane's metrics reader (on unmount). Idempotent. */
export function unregisterPaneMetrics(sessionId: string): void {
  measurers.delete(sessionId)
}

/** The current metrics for `sessionId`'s pane, or `undefined` if none is registered. */
export function measurePane(sessionId: string): PaneMetrics | undefined {
  return measurers.get(sessionId)?.()
}

/** Test seam: drop all registered measurers. */
export function _resetPaneMetrics(): void {
  measurers.clear()
}
