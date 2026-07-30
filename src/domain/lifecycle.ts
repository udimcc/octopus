/**
 * Lifecycle state machines for tasks (§3.5) and sessions (§3.6), plus the
 * lifecycle→aggregation mapping (I12).
 *
 * `SessionLifecycle` answers "is the runtime alive?" and is ORTHOGONAL to
 * `SessionState` ("what is it doing?", V2+). Switching tasks never changes
 * lifecycle — background sessions stay `Running`; visibility is a UI concern
 * (§3.6). The transition tables are the single source of truth for legal moves;
 * `Task`/`Session` consult them and throw {@link IllegalTransitionError} otherwise.
 */

import { SessionState } from './state'

/** Task provisioning/teardown lifecycle (§3.5). */
export enum TaskLifecycle {
  None = 'none',
  Provisioning = 'provisioning',
  Ready = 'ready',
  ProvisionFailed = 'provision_failed',
  Deleting = 'deleting',
  Deleted = 'deleted',
  DeleteFailed = 'delete_failed',
  Stale = 'stale'
}

/** Session runtime lifecycle (§3.6). */
export enum SessionLifecycle {
  None = 'none',
  Created = 'created',
  Starting = 'starting',
  Running = 'running',
  Stopping = 'stopping',
  Closed = 'closed',
  CreateFailed = 'create_failed',
  StartFailed = 'start_failed',
  Exited = 'exited'
}

/**
 * Legal task transitions (§3.5). Terminal state `Deleted` has no successors.
 * `ProvisionFailed` may retry (→ Provisioning) or discard (→ Deleted; no worktree
 * to tear down). `Stale` (I14: worktree missing on startup) may be re-provisioned
 * or force-forgotten. `DeleteFailed` may retry or force-forget (§3.5, I4).
 */
const TASK_TRANSITIONS: Readonly<Record<TaskLifecycle, readonly TaskLifecycle[]>> = Object.freeze({
  [TaskLifecycle.None]: [TaskLifecycle.Provisioning],
  [TaskLifecycle.Provisioning]: [TaskLifecycle.Ready, TaskLifecycle.ProvisionFailed],
  [TaskLifecycle.Ready]: [TaskLifecycle.Deleting, TaskLifecycle.Stale],
  [TaskLifecycle.ProvisionFailed]: [TaskLifecycle.Provisioning, TaskLifecycle.Deleted],
  [TaskLifecycle.Stale]: [
    TaskLifecycle.Provisioning,
    TaskLifecycle.Deleting,
    TaskLifecycle.Deleted
  ],
  [TaskLifecycle.Deleting]: [TaskLifecycle.Deleted, TaskLifecycle.DeleteFailed],
  [TaskLifecycle.DeleteFailed]: [TaskLifecycle.Deleting, TaskLifecycle.Deleted],
  [TaskLifecycle.Deleted]: []
})

/**
 * Legal session transitions (§3.6). Terminal states (`Closed`, `Exited`,
 * `CreateFailed`, `StartFailed`) have no successors. An unexpected process death
 * while `Running` or `Stopping` lands in `Exited`; a user-driven close goes
 * `Running → Stopping → Closed`.
 */
const SESSION_TRANSITIONS: Readonly<Record<SessionLifecycle, readonly SessionLifecycle[]>> =
  Object.freeze({
    [SessionLifecycle.None]: [SessionLifecycle.Created],
    [SessionLifecycle.Created]: [SessionLifecycle.Starting, SessionLifecycle.CreateFailed],
    [SessionLifecycle.Starting]: [SessionLifecycle.Running, SessionLifecycle.StartFailed],
    [SessionLifecycle.Running]: [SessionLifecycle.Stopping, SessionLifecycle.Exited],
    [SessionLifecycle.Stopping]: [SessionLifecycle.Closed, SessionLifecycle.Exited],
    [SessionLifecycle.Closed]: [],
    [SessionLifecycle.CreateFailed]: [],
    [SessionLifecycle.StartFailed]: [],
    [SessionLifecycle.Exited]: []
  })

/** True iff `from → to` is a legal task-lifecycle transition (§3.5). */
export function canTransitionTask(from: TaskLifecycle, to: TaskLifecycle): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

/** True iff `from → to` is a legal session-lifecycle transition (§3.6). */
export function canTransitionSession(from: SessionLifecycle, to: SessionLifecycle): boolean {
  return SESSION_TRANSITIONS[from].includes(to)
}

/**
 * Map a session's (lifecycle, state) to the {@link SessionState} it contributes
 * to task aggregation (I12).
 *
 * - A session that has `Exited` or `StartFailed` maps to `Blocked` — a dead or
 *   never-started session demands attention regardless of its evaluated state.
 * - Otherwise the session contributes its evaluated `state`. In V1 no session is
 *   ever evaluated (Terminal lacks `EvaluatesState`), so a live session
 *   contributes `Unknown` and is transparent (§3.4, §10 V1). This function does
 *   not change across versions; V2 simply starts producing non-`Unknown` states.
 */
export function lifecycleToAggregationState(
  lifecycle: SessionLifecycle,
  state: SessionState
): SessionState {
  if (lifecycle === SessionLifecycle.Exited || lifecycle === SessionLifecycle.StartFailed) {
    return SessionState.NeedsInput
  }
  return state
}
