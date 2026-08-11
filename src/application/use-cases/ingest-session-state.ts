/**
 * `ingestSessionState` (DESIGN §9.6, §3.4) — the Claude state watcher dispatches
 * this command with a freshly read {@link SessionState}; the loop applies it to the
 * session, recomputes the owning task's aggregate `TaskState` (worst-status-wins,
 * §3.4) and emits the two state-changed events the renderer already understands.
 *
 * Runs on the single writer (§6.6): the watcher's file-change callback routes
 * through the command loop rather than mutating the domain inline, so the
 * `setState` + derivation stay serialized with every other workspace mutation.
 *
 * Idempotent-friendly: it publishes unconditionally (even if the state is
 * unchanged) — the watcher debounces upstream per file, so a redundant signal here
 * would be rare and the events are cheap; the renderer patch is a no-op when equal.
 */

import type { AppDependencies } from '../dependencies'
import type { IngestSessionStateInput } from '../commands'
import { SessionState } from '../../domain/state'
import { locateSession } from './locate-session'

export function ingestSessionState(deps: AppDependencies, input: IngestSessionStateInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    return
  }
  const { task, session } = located

  // Capture the prior state BEFORE the mutation so the transition log records the
  // from → to delta (§11), then apply the evaluated state to the session; the
  // task's aggregate is always DERIVED (I11) via the injected aggregator (§3.4).
  const from = session.state
  session.setState(input.state)
  const taskState = task.deriveState(deps.aggregator)

  // Best-effort record for threshold tuning + the debug overlay (§11, R1). The
  // adapter swallows its own I/O errors; it must never derail the writer (§6.6).
  deps.stateLog?.record({
    at: deps.clock.now(),
    sessionId: input.sessionId,
    taskId: task.id,
    from,
    to: input.state,
    meta: input.meta
  })

  // Announce both the per-session and the derived task state so the renderer can
  // update the session-tab icon and the (aggregated) task-list icon.
  deps.bus.publish({
    type: 'sessionStateChanged',
    sessionId: input.sessionId,
    state: input.state,
    meta: input.meta
  })
  deps.bus.publish({
    type: 'taskStateChanged',
    taskId: task.id,
    state: taskState
  })

  // Best-effort in-app notification (§9.5) on a MEANINGFUL transition: skip the
  // initial `Unknown → …` (every session's first signal — noise) and any
  // `… → Unknown`, and skip a no-op (redundant debounced signal). The sink itself
  // (composition root) gates on the user setting, throttles a burst per task+session
  // (6s), and routes to the active window; this use-case stays unaware of
  // windows/settings so it remains a pure writer. The notification carries only names
  // (no from/to) — the toast just says "state changed" and the user checks the session.
  if (
    from !== input.state &&
    from !== SessionState.Unknown &&
    input.state !== SessionState.Unknown
  ) {
    deps.onSessionStateNotification?.({
      sessionId: input.sessionId,
      taskName: task.name,
      sessionName: session.title
    })
  }
}
