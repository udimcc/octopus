/**
 * Session/task state model (DESIGN §3.3, §3.4). These enums and the aggregation
 * lattice are DEFINED in V1 but inert: no V1 signal ever moves a session off
 * `Unknown`, so the aggregator always yields `Unknown` and the UI renders no
 * icons (§10 V1). V2 implements the providers that emit real states; the
 * signatures here do not change.
 */

/** What a session is doing (V2+). Default and only V1 value: `Unknown`. */
export enum SessionState {
  Unknown = 'unknown',
  Waiting = 'waiting',
  Working = 'working',
  Blocked = 'blocked'
}

/** Aggregate task state — always DERIVED from child sessions, never assigned (I11). */
export enum TaskState {
  Unknown = 'unknown',
  Waiting = 'waiting',
  Working = 'working',
  Blocked = 'blocked'
}

/**
 * Internal-only session sub-states (DESIGN §3.3, §9.1). Defined now for the V2
 * confidence-scoring seam; they feed scoring, never the UI, and every one maps
 * to a display {@link SessionState}. Unused in V1.
 */
export enum SessionSubState {
  Initializing = 'initializing',
  WaitingAtPrompt = 'waiting/at_prompt',
  WaitingExplicit = 'waiting/explicit',
  WorkingSubprocess = 'working/subprocess',
  WorkingExplicit = 'working/explicit',
  BlockedPermission = 'blocked/permission',
  BlockedExplicit = 'blocked/explicit',
  BlockedHeuristic = 'blocked/heuristic'
}

/**
 * The worst-status-wins lattice (§3.4): `Blocked > Working > Waiting > Unknown`.
 * A higher rank wins the `max` reduction. Exhaustive over {@link SessionState}
 * and {@link TaskState} (identical members).
 */
export const STATE_RANK: Readonly<Record<SessionState, number>> = Object.freeze({
  [SessionState.Unknown]: 0,
  [SessionState.Waiting]: 1,
  [SessionState.Working]: 2,
  [SessionState.Blocked]: 3
})
