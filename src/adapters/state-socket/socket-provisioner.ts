/**
 * Per-session state-socket provisioner (DESIGN §9.2, §10 V1 seam). DORMANT in V1:
 * it computes the socket path and creates the private parent directory, exports
 * `OCTOPUS_STATE_SOCKET` into the PTY env (via the runtime context), but NO
 * listener is ever bound. V2's `ClaudeCodeProvider` binds and reads it; the path
 * shape and the `chmod 700` dir do not change.
 *
 * Path: `/tmp/octopus-<uid>/session-<sessionId>.sock`, dir mode 0o700 so only the
 * owner can connect (a socket is a capability — §9.2). Mirrors the pure-resolver
 * / effectful-wrapper split: {@link socketPathFor} is pure; {@link ensureSocketDir}
 * does the one filesystem side effect.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionId } from '../../domain/ids'

export interface SocketProvisioner {
  /** The (unbound) socket path for a session (§9.2). */
  socketPathFor(sessionId: SessionId): string
  /** Ensure the private parent dir exists (0o700). Idempotent. */
  ensureSocketDir(): void
}

/** Pure: the directory holding this uid's session sockets. */
export function socketDirFor(uid: number, base: string = tmpdir()): string {
  return join(base, `octopus-${uid}`)
}

/** Pure: the socket path for a given session. */
export function socketPathFor(uid: number, sessionId: SessionId, base: string = tmpdir()): string {
  return join(socketDirFor(uid, base), `session-${sessionId}.sock`)
}

/**
 * Build a provisioner bound to a uid. In V1 nothing listens; the exported path is
 * only an environment hint for V2 tooling.
 */
export function createSocketProvisioner(uid: number, base: string = tmpdir()): SocketProvisioner {
  const dir = socketDirFor(uid, base)
  return {
    socketPathFor: (sessionId) => socketPathFor(uid, sessionId, base),
    ensureSocketDir: () => {
      // 0o700: the socket is a capability; only the owner may connect (§9.2).
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }
}
