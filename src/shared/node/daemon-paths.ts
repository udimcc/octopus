/**
 * Daemon socket/lock path helpers (DESIGN §6.2, §9.2). The daemon's CONTROL
 * socket shares the same per-uid private directory as the dormant per-session
 * state sockets (`/tmp/octopus-<uid>/`, mode 0700) — a socket is a capability, so
 * only the owner may connect. This is a NEW, separate socket from the state
 * sockets (`session-<id>.sock`); it is the single control channel between the app
 * and `octopusd`.
 *
 * Pure path builders + one effectful dir-ensure, mirroring the resolver/wrapper
 * split used across the codebase (`paths.ts`, `socket-provisioner.ts`).
 *
 * Lives under `src/shared/node/` (not `src/daemon/`) because BOTH ends need it: the
 * daemon binds the socket here, and the main-side composition root must derive the
 * SAME path to connect. Placing it in `shared` lets `main`/`adapters` import it
 * without violating the boundary rule (they may not import `src/daemon/**`). Uses
 * node `fs`/`os`/`path`, so it belongs under `shared/node`, not the browser-safe
 * `shared` root.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Pure: the private per-uid directory holding the daemon's sockets. */
export function daemonDirFor(uid: number, base: string = tmpdir()): string {
  return join(base, `octopus-${uid}`)
}

/** Pure: the daemon control-socket path. */
export function controlSocketPath(uid: number, base: string = tmpdir()): string {
  return join(daemonDirFor(uid, base), 'octopusd.sock')
}

/** Ensure the private parent dir exists (0o700). Idempotent. */
export function ensureDaemonDir(uid: number, base: string = tmpdir()): string {
  const dir = daemonDirFor(uid, base)
  // 0o700: the control socket is a capability; only the owner may connect (§9.2).
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Current uid; 0 on platforms without `process.getuid` (matches socket-provisioner). */
export function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}
