/**
 * The Layer-3 explicit-signal SOURCE that binds the per-session Unix socket
 * (DESIGN §9.2). A program that knows its own state — Claude Code via its hooks
 * (§9.2, §12.1) — connects to `$OCTOPUS_STATE_SOCKET` and writes newline-delimited
 * JSON `{state,reason?,tool?}` frames; this listener validates each and forwards it
 * to a sink (the {@link CompositeStateProvider}'s `submitExplicit`).
 *
 * Lives in `shared/node/state` because BOTH backends bind it where the session runs
 * (§9.6): Electron main for the in-process runtime, `octopusd` for the daemon. The
 * socket's parent dir is already `chmod 700` (owner-only — a socket is a capability,
 * §9.2); the listener adds these defenses so a compromised/confused client in the
 * session can't do harm:
 *   - every frame is length-capped and parsed by {@link parseStateJson} (≤1 KB,
 *     valid JSON object, KNOWN state string) — nothing from a frame is ever executed;
 *   - a per-connection read buffer is bounded (a frame with no newline can't grow
 *     memory without limit) and the connection is dropped past the cap;
 *   - it is newline-DELIMITED so a client may report many transitions on one
 *     long-lived connection (Claude's PreToolUse/Stop/Notification hooks, §9.2).
 *
 * Errors are swallowed (a state signal is best-effort; a bad client must degrade to
 * the heuristic, never crash the session). No `domain` import (shared convention):
 * the parsed state is a plain string, mapped at the adapter edge.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import { parseStateJson } from './osc-parser'
import type { ExplicitSignal } from './state-core'

/** Max bytes buffered for a single (newline-terminated) frame before we drop the client. */
const MAX_FRAME_BYTES = 4096

export interface StateSocketListener {
  /** Stop accepting connections and remove the socket file. Idempotent. */
  close(): void
}

/**
 * Bind a listening Unix socket at `socketPath` and forward every valid state frame
 * to `onSignal`. Returns a handle whose `close()` tears it down. A pre-existing
 * stale socket file is removed first (a prior crashed session), matching the
 * daemon's own bind hygiene.
 */
export function bindStateSocket(
  socketPath: string,
  onSignal: (signal: ExplicitSignal) => void
): StateSocketListener {
  // Clear a stale socket file from a crashed predecessor so bind() doesn't EADDRINUSE.
  try {
    unlinkSync(socketPath)
  } catch {
    // Nothing there (the common case) — ignore.
  }

  const server: Server = createServer((conn: Socket) => handleConnection(conn, onSignal))
  server.on('error', () => {
    // A bind failure must not crash the host process; the session simply runs
    // without its L3 source and degrades to the L2 heuristic (§9.1).
  })
  try {
    server.listen(socketPath)
  } catch {
    // Same degradation as above.
  }

  let closed = false
  return {
    close(): void {
      if (closed) {
        return
      }
      closed = true
      try {
        server.close()
      } catch {
        /* already down */
      }
      try {
        unlinkSync(socketPath)
      } catch {
        /* already gone */
      }
    }
  }
}

function handleConnection(conn: Socket, onSignal: (signal: ExplicitSignal) => void): void {
  let buf = ''
  conn.setEncoding('utf8')
  conn.on('data', (chunk: string) => {
    buf += chunk
    // Bounded buffer: a frame with no newline can't grow memory unbounded (§9.2).
    if (buf.length > MAX_FRAME_BYTES) {
      conn.destroy()
      return
    }
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const frame = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      dispatchFrame(frame, onSignal)
      nl = buf.indexOf('\n')
    }
  })
  // A client may also send a single frame and close without a trailing newline.
  conn.on('end', () => {
    if (buf.length > 0 && buf.length <= MAX_FRAME_BYTES) {
      dispatchFrame(buf, onSignal)
      buf = ''
    }
  })
  conn.on('error', () => {
    /* client vanished — best-effort, ignore */
  })
}

function dispatchFrame(frame: string, onSignal: (signal: ExplicitSignal) => void): void {
  const trimmed = frame.trim()
  if (trimmed.length === 0) {
    return
  }
  const parsed = parseStateJson(trimmed)
  if (!parsed) {
    return
  }
  onSignal({ state: parsed.state, reason: parsed.reason, tool: parsed.tool })
}
