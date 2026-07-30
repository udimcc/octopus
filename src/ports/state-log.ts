/**
 * `StateLog` port (DESIGN §11 observability, R1). A structured, append-only record
 * of every session state transition — the raw material for tuning the §9.3
 * debounce/hysteresis thresholds and for the keyboard-toggled debug overlay (§10).
 *
 * The application records one {@link StateTransition} per ingested state change
 * (`ingestSessionState`, §9.6). Recording is BEST-EFFORT by contract: an
 * implementation must never throw into the caller — a failed write must not derail
 * the single-writer command loop or block a state update (§6.6). The concrete
 * adapter (`state-log-file`) appends JSONL to `paths.stateLogPath`.
 */

import type { SessionId, TaskId } from '../domain/ids'
import type { SessionState } from '../domain/state'
import type { StateChangeMeta } from './session-runtime'

/** One recorded session-state transition (§11). Serialized as a single JSONL line. */
export interface StateTransition {
  /** Epoch milliseconds the transition was ingested (from the {@link Clock}). */
  readonly at: number
  readonly sessionId: SessionId
  /** The owning task, for grouping transitions in the overlay/analysis. */
  readonly taskId: TaskId
  /** State before the change (the session's prior value), for delta analysis. */
  readonly from: SessionState
  /** The newly-applied state. */
  readonly to: SessionState
  /** Layer/confidence/reason of the deciding signal (§9.1, §9.3), when supplied. */
  readonly meta?: StateChangeMeta
}

export interface StateLog {
  /**
   * Append one transition. Best-effort: swallows its own I/O errors (must never
   * throw into the command loop). A no-op implementation disables the log.
   */
  record(transition: StateTransition): void
}
