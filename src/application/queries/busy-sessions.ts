/**
 * `busySessions` read-model query (DESIGN §6.6, I13, R4). Counts the live sessions
 * whose evaluated state is `Working` or `Blocked` (Needs input) — the "you have work
 * in progress" surface behind the quit warning.
 *
 * Pure over the {@link Workspace} aggregate (no I/O, no runtime handles), so it is
 * unit-testable without Electron and callable straight from the `before-quit` handler.
 * We read each session's evaluated {@link SessionState} directly rather than
 * `aggregationState()` on purpose: I12 maps an `Exited`/`StartFailed` session to
 * `Blocked` for *task* aggregation, but a dead shell is not in-progress work — quitting
 * loses nothing there, so it must not trigger the warning.
 *
 * Only `Running` sessions are considered: state is evaluated only while the runtime is
 * alive (§9), and quit-time work loss is exactly a live-shell concern.
 */

import type { Workspace } from '../../domain/workspace'
import { SessionLifecycle } from '../../domain/lifecycle'
import { SessionState } from '../../domain/state'

/** Tally of live in-progress sessions at quit time (DESIGN §6.6). */
export interface BusySessionsSummary {
  /** Live sessions evaluated `Working`. */
  readonly working: number
  /** Live sessions evaluated `Blocked` (Needs input). */
  readonly blocked: number
  /** Distinct tasks owning at least one busy session. */
  readonly tasks: number
}

/** True iff any session in the tally is busy — the quit-warning trigger. */
export function isBusy(summary: BusySessionsSummary): boolean {
  return summary.working + summary.blocked > 0
}

/** Count the live `Working`/`Blocked` sessions across every task (§6.6). */
export function busySessions(workspace: Workspace): BusySessionsSummary {
  let working = 0
  let blocked = 0
  let tasks = 0
  for (const task of workspace.tasks()) {
    let taskHasBusy = false
    for (const session of task.sessions()) {
      if (session.lifecycle !== SessionLifecycle.Running) {
        continue
      }
      if (session.state === SessionState.Working) {
        working++
        taskHasBusy = true
      } else if (session.state === SessionState.NeedsInput) {
        blocked++
        taskHasBusy = true
      }
    }
    if (taskHasBusy) {
      tasks++
    }
  }
  return { working, blocked, tasks }
}
