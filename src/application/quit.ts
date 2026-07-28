/**
 * Graceful shutdown (DESIGN §6.3 Quit, §7 I13, roadmap §6.1). On app quit:
 *
 *   1. Release every live runtime. On the IN-PROCESS backend this SIGHUPs each
 *      child shell (fire-and-forget `stop()`), so it gets a chance to run its own
 *      cleanup; V1 signals the single PTY, not its process group (group-kill via
 *      `setsid` is a documented V2 item, §6.1). On the DAEMON backend we instead
 *      `dispose()` — a DETACH that leaves the PTY running in `octopusd` so the next
 *      launch re-attaches to the still-live shell (the whole point of the durable
 *      backend, §6.2). Killing them here would defeat durability.
 *   2. `checkpointAndClose()` the persistence store (`wal_checkpoint(TRUNCATE)`
 *      + close), so metadata is durably flushed and no stray WAL remains (§6.3).
 *
 * We do NOT wait for the graceful window / SIGKILL escalation here: quit must be
 * prompt, the OS reaps the children (in-process), and I13 still forbids persisting
 * live *process* state in the Electron process — on the in-process path relaunch
 * opens FRESH shells regardless of how these died. A "Working/Blocked tasks — quit
 * anyway?" warning hook belongs above this (degenerate in V1: every task is
 * `Unknown`), so this function just tears down.
 *
 * Idempotent and best-effort: a release that throws must not block the store
 * checkpoint, and vice versa.
 */

import type { AppDependencies } from './dependencies'

export interface ShutdownOptions {
  /**
   * The durable daemon backend is active (§6.2): release runtimes with `dispose()`
   * (DETACH — PTYs keep running for re-attach) instead of `stop()` (which would
   * `close` them daemon-side and kill the shells). Absent/false = in-process, the
   * V1 SIGHUP-every-shell behavior — unchanged.
   */
  readonly daemonBackend?: boolean
  /**
   * Called once, AFTER runtimes are released and BEFORE the store checkpoint, to
   * drop the daemon socket (the daemon treats the disconnect as detach-all, so the
   * PTYs keep running). No-op on the in-process path.
   */
  readonly onReleased?: () => void
}

export function shutdown(deps: AppDependencies, opts: ShutdownOptions = {}): void {
  for (const runtime of deps.runtimes.all()) {
    try {
      // Daemon backend: DETACH (dispose) so the PTY survives for re-attach (§6.2).
      // In-process: SIGHUP (stop), fire-and-forget — no grace window on quit.
      if (opts.daemonBackend) {
        runtime.dispose()
      } else {
        void runtime.stop()
      }
    } catch {
      // Ignore — on the in-process path the OS reaps the child (nothing to persist,
      // I13); on the daemon path a failed detach still leaves the PTY running.
    }
  }
  deps.runtimes.clear()

  // Daemon path: drop the client socket now that every runtime has detached. The
  // daemon interprets the disconnect as detach-all and keeps every PTY alive (§6.2).
  if (opts.onReleased) {
    try {
      opts.onReleased()
    } catch {
      // Best-effort — a socket-teardown failure must not block the checkpoint.
    }
  }

  // Flush every session's captured output to the store so it can be replayed on
  // the next launch (§6.6). Ordering is load-bearing: AFTER `runtimes.clear()` (no
  // more `onData` can race the buffer) and BEFORE `checkpointAndClose()` (the store
  // is still open). Best-effort per session — one bad write must not skip the rest.
  for (const [sessionId, data] of deps.scrollbacks.entries()) {
    try {
      deps.persistence.saveScrollback(sessionId, data)
    } catch {
      // Ignore — scrollback is a convenience, not correctness; keep flushing.
    }
  }

  try {
    deps.persistence.checkpointAndClose()
  } catch {
    // Best-effort: a checkpoint failure must not hang quit.
  }
}
