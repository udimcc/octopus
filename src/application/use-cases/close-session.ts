/**
 * `closeSession` use case (DESIGN §3.6, §6.1). The USER-driven close, distinct
 * from a spontaneous process death (`handleRuntimeExit` → `Exited`). Sequence:
 *
 *   Running → `markStopping` → `runtime.stop()` (SIGHUP → grace → SIGKILL) →
 *   `markClosed` → dispose + drop from the registry → `removeSession` from the
 *   task → persist (delete the row; the definition is gone) → emit `sessionClosed`.
 *
 * The runtime suppresses its own `onExit` while stopping (its `stopping` flag),
 * so the exit that `stop()` triggers does NOT also route through the loop as a
 * `handleRuntimeExit` — this use-case owns the Stopping→Closed transition and the
 * illegal `Closed → Exited` race cannot occur (§6.1, §6.6).
 *
 * A session that has ALREADY reached a terminal lifecycle (Exited/StartFailed/
 * CreateFailed/Closed) — e.g. its process died between the click and here — skips
 * the stop/close transitions but is still removed + its row deleted, so the UI's
 * close always takes effect. Removing the active session re-points the task's
 * active session to the first remaining one (Task.removeSession, I10).
 *
 * `Task.removeSession` also drops the closed session's leaf from its group, if
 * any — dissolving the group at 1 remaining member (DESIGN §5.7, same as `leave`,
 * except there is no tab to reposition since the leaving session itself is gone).
 * `finishClose` persists that group diff and publishes `groupsChanged` whenever
 * the closed session WAS grouped, so a leaf drop/dissolve is announced the same
 * way every other group mutation is.
 */

import type { AppDependencies } from '../dependencies'
import type { CloseSessionInput } from '../commands'
import type { Task } from '../../domain/task'
import { SessionLifecycle } from '../../domain/lifecycle'
import { locateSession } from './locate-session'
import { persistGroups } from './persist-groups'

export async function closeSession(deps: AppDependencies, input: CloseSessionInput): Promise<void> {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    // Idempotent: closing an already-gone session is a no-op (may race an exit).
    return
  }
  const { task, session } = located
  const runtime = deps.runtimes.get(input.sessionId)

  // Drive Running → Stopping → Closed only when the runtime is actually alive.
  // A terminal session skips the transitions but is still removed below.
  const alive =
    session.lifecycle === SessionLifecycle.Running ||
    session.lifecycle === SessionLifecycle.Stopping

  if (alive) {
    if (session.lifecycle === SessionLifecycle.Running) {
      session.markStopping()
    }
    if (runtime) {
      try {
        await runtime.stop()
      } catch {
        // Stop failure must not strand the tab; dispose forcibly below.
      }
    }
    session.markClosed()
  }

  if (runtime) {
    runtime.dispose()
    deps.runtimes.delete(input.sessionId)
  }

  finishClose(deps, task, input.sessionId)
}

/** Remove the session from its task, delete its row, and announce the close. */
function finishClose(
  deps: AppDependencies,
  task: Task,
  sessionId: CloseSessionInput['sessionId']
): void {
  const taskId = task.id
  // Capture whether — and what — this session's group looked like BEFORE removal
  // (DESIGN §5.7): `removeSession` drops its leaf (dissolving at 1 member), and
  // only a session that WAS grouped can have changed the group list.
  const wasGrouped = task.groupOf(sessionId) !== undefined
  const groupsBefore = task.groups()
  task.removeSession(sessionId)
  const groupsAfter = task.groups()

  // Free the in-memory scrollback buffer immediately — a user close removes the
  // session for good (unlike a spontaneous exit, which keeps it). The persisted
  // `session_scrollback` row is purged automatically by `ON DELETE CASCADE` when
  // the session row is deleted below, so no explicit scrollback DB delete is needed.
  deps.scrollbacks.delete(sessionId)

  deps.persistence.transaction(() => {
    deps.persistence.deleteSession(sessionId)
    // active_session_id may have shifted to another tab; persist the task row too.
    deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
    if (wasGrouped) {
      persistGroups(deps.persistence, taskId, groupsBefore, groupsAfter)
    }
  })

  deps.bus.publish({ type: 'sessionClosed', taskId, sessionId })
  if (wasGrouped) {
    deps.bus.publish({ type: 'groupsChanged', taskId, groups: groupsAfter })
  }
  // The removed session no longer contributes to the task rollup; announce the
  // recomputed worst-wins state so a late-joining window (or one that missed the
  // close→recompute in its own store) stays consistent (§3.4, §6.6).
  deps.bus.publish({ type: 'taskStateChanged', taskId, state: task.deriveState(deps.aggregator) })
}
