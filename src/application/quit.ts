/**
 * Graceful shutdown (DESIGN §6.3 Quit, §7 I13, roadmap §6.1). On app quit:
 *
 *   1. SIGHUP every live runtime (fire-and-forget `stop()`), so child shells get
 *      a chance to run their own cleanup. V1 signals the single PTY, not its
 *      process group — group-kill via `setsid` is a documented V2 item (§6.1).
 *   2. `checkpointAndClose()` the persistence store (`wal_checkpoint(TRUNCATE)`
 *      + close), so metadata is durably flushed and no stray WAL remains (§6.3).
 *
 * We do NOT wait for the graceful window / SIGKILL escalation here: quit must be
 * prompt, the OS reaps the children, and I13 forbids persisting live process
 * state — on relaunch, reconcile opens FRESH shells regardless of how these died.
 * A "Working/Blocked tasks — quit anyway?" warning hook belongs above this (it is
 * degenerate in V1: every task is `Unknown`), so this function just tears down.
 *
 * Idempotent and best-effort: a `stop()` that throws must not block the store
 * checkpoint, and vice versa.
 */

import type { AppDependencies } from './dependencies'

export function shutdown(deps: AppDependencies): void {
  for (const runtime of deps.runtimes.all()) {
    try {
      // Fire-and-forget: we don't await the grace window on quit.
      void runtime.stop()
    } catch {
      // Ignore — the OS reaps the child; nothing to persist (I13).
    }
  }
  deps.runtimes.clear()

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
