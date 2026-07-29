/**
 * Best-effort current-working-directory of a live process, via `/proc/<pid>/cwd`
 * (DESIGN §6.2). Reading that symlink is the only way to observe where a shell has
 * `cd`'d to after spawn — the PTY carries no cwd of its own.
 *
 * Lives under `src/shared/node/` (not `src/daemon/`) because BOTH ends need it: the
 * daemon resolves it for its `listSessions` roster, and the in-process
 * `PtyTerminalRuntime` (an adapter) resolves it for the same query. Placing it in
 * `shared` lets `adapters` import it without violating the boundary rule (adapters
 * may not import `src/daemon/**`). Uses node `fs`, so it belongs under `shared/node`,
 * not the browser-safe `shared` root.
 *
 * Linux-only by design (the target is a Linux VDI); on any platform without
 * `/proc`, or for a pid that has already exited, the readlink throws and this
 * returns `undefined` — callers treat that as "cwd unavailable".
 */

import { readlinkSync } from 'node:fs'

/** Best-effort cwd of a pid via /proc (Linux). Undefined if unresolvable. */
export function procCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return undefined
  }
}
