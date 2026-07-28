/**
 * A `SessionManager` that delegates to a swappable backend (DESIGN §6.2). It exists
 * to honor the user-chosen daemon fallback: the app starts on the in-process
 * backend and, once the async daemon warmup at boot confirms a reachable
 * `octopusd`, swaps the delegate to the {@link DaemonSessionManager}. If the daemon
 * can be neither reached NOR launched, the delegate simply stays in-process for
 * that run (degrade-to-in-process) — no session ever fails just because the daemon
 * is down.
 *
 * The swap happens during `AppContext.warmupSessions()`, BEFORE any renderer
 * `switchTask` triggers the first `startTaskSessions`, so `createRuntime` always
 * sees the settled delegate. Mirrors `SelectingWorktreeProvider`'s delegate pattern
 * so the composition root can hold one stable `deps.sessions` reference whose
 * behavior is chosen at runtime.
 */

import type {
  SessionManager,
  SessionRuntime,
  SessionRuntimeContext
} from '../../ports/session-runtime'

export class SwitchableSessionManager implements SessionManager {
  private delegate: SessionManager

  constructor(initial: SessionManager) {
    this.delegate = initial
  }

  /** Swap the active backend (called once by the daemon warmup on success). */
  setDelegate(next: SessionManager): void {
    this.delegate = next
  }

  createRuntime(ctx: SessionRuntimeContext): SessionRuntime {
    return this.delegate.createRuntime(ctx)
  }
}
