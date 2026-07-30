/**
 * Task-state aggregation strategy (DESIGN §3.4). The rule is worst-status-wins:
 * a pure `max` over the lattice `Blocked > Working > Waiting > Unknown`. Because
 * it is total, associative and commutative it is order-independent and trivially
 * testable.
 *
 * Implemented as a strategy (§3.4 "Pluggability") so the alternative
 * "Waiting > Working" precedence can be offered as a setting in V2 without
 * touching the `Task` entity. In V1 every session is `Unknown`, so this always
 * returns `TaskState.Unknown` and the UI shows no icon.
 */

import { SessionState, TaskState, STATE_RANK } from './state'

export interface TaskStateAggregator {
  /** Reduce child session states to a single task state. */
  aggregate(sessionStates: readonly SessionState[]): TaskState
}

/** Map a {@link SessionState} to the identically-named {@link TaskState}. */
function toTaskState(s: SessionState): TaskState {
  switch (s) {
    case SessionState.NeedsInput:
      return TaskState.NeedsInput
    case SessionState.Working:
      return TaskState.Working
    case SessionState.Idle:
      return TaskState.Idle
    case SessionState.Unknown:
      return TaskState.Unknown
  }
}

/**
 * Worst-status-wins aggregator. Empty task or all-`Unknown` → `Unknown` (no
 * icon), so an un-evaluated terminal never masks a blocked build, and an empty
 * task never falsely implies the user has something to act on (§3.4).
 */
export const worstStatusWins: TaskStateAggregator = {
  aggregate(sessionStates) {
    let worst = SessionState.Unknown
    for (const s of sessionStates) {
      if (STATE_RANK[s] > STATE_RANK[worst]) {
        worst = s
      }
    }
    return toTaskState(worst)
  }
}
