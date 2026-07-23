/**
 * `ingestSessionState` — the DORMANT §10 V1 seam. A V2 per-session state provider
 * (behind the `EvaluatesState` capability) will dispatch this command with a
 * freshly evaluated {@link SessionState}; the loop recomputes the owning task's
 * aggregate `TaskState` (worst-status-wins, §3.4) and emits the state-changed
 * events the renderer already understands.
 *
 * In V1 NOBODY dispatches this: no session type declares `EvaluatesState`, no
 * runtime returns a `stateEvaluator()`, so no state signal is ever produced. It
 * is fully wired anyway (command union → loop switch → here) so V2 only has to
 * start *emitting* — the plumbing, the events, and the store handlers all exist.
 *
 * Because V1 never calls it, the body must have no V1-observable effect beyond
 * being type-correct. It is written as the real V2 logic would be so the seam is
 * exercised by the type checker and reads as intent, not a stub.
 */

import type { AppDependencies } from '../dependencies'
import type { IngestSessionStateInput } from '../commands'
import { locateSession } from './locate-session'

export function ingestSessionState(deps: AppDependencies, input: IngestSessionStateInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    return
  }
  const { task } = located

  // V2 would apply `input.state` to the session here (a `Session.setState` the
  // domain will add behind the same seam). The task's aggregate state is always
  // DERIVED (I11) via the injected aggregator — in V1 that yields `Unknown`.
  const taskState = task.deriveState(deps.aggregator)

  // Announce both the per-session and the derived task state. In V1 these carry
  // `Unknown` and the renderer draws no icon; the events exist so V2 is additive.
  deps.bus.publish({
    type: 'sessionStateChanged',
    sessionId: input.sessionId,
    state: input.state
  })
  deps.bus.publish({
    type: 'taskStateChanged',
    taskId: task.id,
    state: taskState
  })
}
