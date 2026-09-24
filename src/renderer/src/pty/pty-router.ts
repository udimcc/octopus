/**
 * The ptyData bypass (DESIGN §5.2/§5.3/§6.5). Terminal output is high-frequency
 * (potentially 60Hz); routing it through Zustand + React would trash the frame
 * budget. So a SINGLE top-level `octopusAPI.onEvent` subscription splits the
 * stream: `ptyData` goes straight to the owning terminal's write sink, and every
 * other event goes to `store.applyEvent`.
 *
 * A `TerminalPane` registers its sink on mount and unregisters on close. Output
 * that arrives for a session with no live sink — the pre-mount window (a session
 * created/restored before its pane has mounted) — is not dropped: it accumulates
 * in a per-session bounded ring buffer and is replayed into the sink the instant
 * it registers. On register we replay then clear, so nothing is shown twice.
 *
 * SCOPE (§6.6): the design puts a durable replay buffer in the *backend* and skips
 * sending output to inactive tabs. The V1 backend is frozen and keep-alive keeps
 * every mounted pane's sink live, so this renderer-side buffer is the honest V1
 * realization of the replay guarantee for the pre-mount / session-restore window;
 * xterm's own scrollback covers everything after mount. The backend
 * "don't-send-to-inactive" optimization stays a deferred V2 perf item (not
 * user-visible). The cap here is INDEPENDENT of (and 10× smaller than) the backend
 * `RingBuffer` default of 5 MB per session (`daemon-pty.ts`): the daemon buys deep
 * scrollback for re-attach, while this buffer only has to cover the milliseconds
 * before a pane mounts, and it is paid 47× in one renderer process.
 *
 * MULTI-WINDOW (V1.5, §6.7): this module and its `sinks`/buffer maps are module-level
 * state, so each secondary window's renderer process gets its OWN independent router
 * — no change needed. The backend `WindowRegistry` routes `ptyData` only to the window
 * currently hosting the session, so a moved session's output follows it here.
 */

import type { EventDTO } from '../../../shared/events'
import { OutputTail, OUTPUT_TAIL_MAX_BYTES } from '../../../shared/output-tail'

type WriteSink = (data: string) => void

const sinks = new Map<string, WriteSink>()

/**
 * Per-session pre-mount buffer: the `ptyData` seen while no sink was registered,
 * bounded to the newest {@link REPLAY_BUFFER_MAX_BYTES} units of the stream.
 *
 * The bound is on BYTES, not chunks — see `shared/output-tail.ts`. This buffer is on
 * the critical path of session restore: `warmupSessions()` re-attaches every live
 * daemon session BEFORE any window exists, so EVERY session's replay lands here and
 * waits for its pane to mount. A chunk-granular eviction policy therefore threw away
 * all restored history the moment one more byte of output arrived (the replay is a
 * single multi-megabyte chunk that alone fills the cap), which is precisely the "no
 * history in any terminal after re-login" bug.
 */
const pending = new Map<string, OutputTail>()

/** Bound per session (~500 KB), shared with the main-process pre-hydration queue. */
export const REPLAY_BUFFER_MAX_BYTES = OUTPUT_TAIL_MAX_BYTES

/** Append a chunk to a session's pending buffer, keeping the newest bytes under the cap. */
function bufferPending(sessionId: string, data: string): void {
  let buf = pending.get(sessionId)
  if (!buf) {
    buf = new OutputTail(REPLAY_BUFFER_MAX_BYTES)
    pending.set(sessionId, buf)
  }
  buf.append(data)
}

/**
 * Register a terminal's write function for a session. Replaces any prior sink and
 * replays (then clears) any output buffered before the pane mounted, so a restored
 * or just-created session shows its backlog rather than starting blank.
 */
export function registerTerminalSink(sessionId: string, write: WriteSink): void {
  sinks.set(sessionId, write)
  const buf = pending.get(sessionId)
  if (buf) {
    pending.delete(sessionId)
    for (const chunk of buf.drain()) write(chunk)
  }
}

/** Remove a session's sink (on pane close). Idempotent. */
export function unregisterTerminalSink(sessionId: string): void {
  sinks.delete(sessionId)
}

/** Test seam: drop all sinks and pending buffers. */
export function _resetSinks(): void {
  sinks.clear()
  pending.clear()
}

/**
 * Wire the one-and-only event subscription. `ptyData` → the registered sink (or the
 * pre-mount buffer if none yet); everything else → `applyEvent`. Returns the
 * unsubscribe fn from the bridge so a caller (or a test) can tear the routing down.
 */
export function initEventRouting(applyEvent: (event: EventDTO) => void): () => void {
  return window.octopusAPI.onEvent((event) => {
    if (event.type === 'ptyData') {
      const sink = sinks.get(event.sessionId)
      if (sink) sink(event.data)
      else bufferPending(event.sessionId, event.data)
      return
    }
    applyEvent(event)
  })
}
