/**
 * The ptyData bypass (DESIGN §5.2/§5.3/§6.5). Terminal output is high-frequency
 * (potentially 60Hz); routing it through Zustand + React would trash the frame
 * budget. So a SINGLE top-level `octopusAPI.onEvent` subscription splits the
 * stream: `ptyData` goes straight to the owning terminal's write sink, and every
 * other event goes to `store.applyEvent`.
 *
 * A `TerminalPane` registers its sink on mount and unregisters on close. Output
 * that arrives for a session with no live sink (e.g. before the pane mounts, or
 * after it unmounts) is dropped — xterm's own scrollback is the buffer of record
 * in V1; a durable server-side ring buffer is a V2 concern (§6.2).
 */

import type { EventDTO } from '../../../shared/events'

type WriteSink = (data: string) => void

const sinks = new Map<string, WriteSink>()

/** Register a terminal's write function for a session. Replaces any prior sink. */
export function registerTerminalSink(sessionId: string, write: WriteSink): void {
  sinks.set(sessionId, write)
}

/** Remove a session's sink (on pane close). Idempotent. */
export function unregisterTerminalSink(sessionId: string): void {
  sinks.delete(sessionId)
}

/** Test seam: drop all sinks. */
export function _resetSinks(): void {
  sinks.clear()
}

/**
 * Wire the one-and-only event subscription. `ptyData` → the registered sink;
 * everything else → `applyEvent`. Returns the unsubscribe fn from the bridge so
 * a caller (or a test) can tear the routing down.
 */
export function initEventRouting(applyEvent: (event: EventDTO) => void): () => void {
  return window.octopusAPI.onEvent((event) => {
    if (event.type === 'ptyData') {
      sinks.get(event.sessionId)?.(event.data)
      return
    }
    applyEvent(event)
  })
}
