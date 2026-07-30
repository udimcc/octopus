/**
 * Session/task state model (DESIGN §3.3, §3.4). These enums and the aggregation
 * lattice are DEFINED in V1 but inert: no V1 signal ever moves a session off
 * `Unknown`, so the aggregator always yields `Unknown` and the UI renders no
 * icons (§10 V1). V2 implements the providers that emit real states; the
 * signatures here do not change.
 */

/**
 * What a Claude session is doing (§9). The four states share ONE vocabulary with
 * the UI — `Unknown` / `Idle` / `Working` / `NeedsInput` — so there is no
 * domain-vs-label translation. The enum VALUES stay the original wire strings
 * (`'waiting'`/`'blocked'`) so IPC, the daemon protocol, persistence and the Claude
 * hook payloads need no migration; only the TypeScript member names changed.
 */
export enum SessionState {
  Unknown = 'unknown',
  Idle = 'waiting',
  Working = 'working',
  NeedsInput = 'blocked'
}

/** Aggregate task state — always DERIVED from child sessions, never assigned (I11). */
export enum TaskState {
  Unknown = 'unknown',
  Idle = 'waiting',
  Working = 'working',
  NeedsInput = 'blocked'
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
  WorkingExplicit = 'working/explicit',
  BlockedPermission = 'blocked/permission',
  BlockedExplicit = 'blocked/explicit'
}

/**
 * The worst-status-wins lattice (§3.4): `NeedsInput > Working > Idle > Unknown`.
 * A higher rank wins the `max` reduction. Exhaustive over {@link SessionState}
 * and {@link TaskState} (identical members).
 */
export const STATE_RANK: Readonly<Record<SessionState, number>> = Object.freeze({
  [SessionState.Unknown]: 0,
  [SessionState.Idle]: 1,
  [SessionState.Working]: 2,
  [SessionState.NeedsInput]: 3
})
