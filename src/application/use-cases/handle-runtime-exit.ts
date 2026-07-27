/**
 * `handleRuntimeExit` use case (DESIGN §6.1, §6.6). A session's process died
 * SPONTANEOUSLY (the runtime's `onExit` fired outside a user close). The runtime
 * callback does NOT mutate the domain inline — it dispatches a `handleRuntimeExit`
 * command so the `markExited` transition runs on the single writer, serialized
 * with every other mutation (§6.6). This is the counterpart to `closeSession`
 * (user-driven → `Closed`); a spontaneous death goes → `Exited` (§3.6).
 *
 * Unlike a close, the session DEFINITION is kept: an exited session stays as a
 * tab so its final scrollback is readable and the user can decide to close it.
 * Lifecycle is never a persisted column (I13); on restart the definition reloads
 * as a fresh Created session regardless. So here we only mark the domain, dispose
 * the runtime, drop it from the registry, and emit `sessionExited` — no row write
 * is needed (the persisted columns of the definition are unchanged).
 */

import type { AppDependencies } from '../dependencies'
import type { HandleRuntimeExitInput } from '../commands'
import { SessionLifecycle } from '../../domain/lifecycle'
import { locateSession } from './locate-session'

export function handleRuntimeExit(deps: AppDependencies, input: HandleRuntimeExitInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    // The session was already closed/removed; the exit is stale. Just make sure
    // no runtime handle leaks.
    const orphan = deps.runtimes.get(input.sessionId)
    if (orphan) {
      orphan.dispose()
      deps.runtimes.delete(input.sessionId)
    }
    return
  }
  const { session } = located

  // Only a live (Running/Stopping) session can transition to Exited (§3.6). A
  // user close that already reached Closed, or a StartFailed session, is terminal
  // — ignore a late exit signal (I13: never resurrect / re-drive terminal state).
  const canExit =
    session.lifecycle === SessionLifecycle.Running ||
    session.lifecycle === SessionLifecycle.Stopping
  if (!canExit) {
    const runtime = deps.runtimes.get(input.sessionId)
    if (runtime) {
      runtime.dispose()
      deps.runtimes.delete(input.sessionId)
    }
    return
  }

  session.markExited(deps.clock.now())

  // A spontaneously-exited session KEEPS its row (its final output stays readable
  // and reloads on restart), so persist the captured scrollback now (§6.6) — the
  // quit flush won't cover it because we're about to drop the runtime and no
  // further `onData` will arrive. The in-memory buffer is NOT deleted (the session
  // persists); it is freed only on user close. Best-effort — never block the exit.
  const scrollback = deps.scrollbacks.snapshot(input.sessionId)
  if (scrollback) {
    try {
      deps.persistence.saveScrollback(input.sessionId, scrollback)
    } catch {
      // Ignore — scrollback persistence is best-effort.
    }
  }

  const runtime = deps.runtimes.get(input.sessionId)
  if (runtime) {
    runtime.dispose()
    deps.runtimes.delete(input.sessionId)
  }

  deps.bus.publish({
    type: 'sessionExited',
    taskId: session.taskId,
    sessionId: input.sessionId,
    exitCode: input.exitCode
  })
}
