/**
 * The single display-state vocabulary for status icons (DESIGN §3.4, §5.4, §9.5).
 *
 * The icon a session (and, rolled up, a task) shows is NOT the raw `SessionState`
 * lattice — it is a *display level* that folds the ready-for-review view-model flag
 * (§9.5) into the same priority ordering as the states themselves. This exists as
 * one enum + one rank map so the per-session icon and the per-task rollup share the
 * exact same precedence logic (computed in the store, rendered by `StatusIcon`).
 *
 * Priority, highest → lowest (higher wins a task rollup):
 *   needsInput  — a session needs the user (domain `blocked`; also exited/failed, I12).
 *   review      — a session that JUST finished while unfocused and hasn't been seen.
 *   working     — a session actively doing something (domain `working`).
 *   idle        — alive but at a prompt (domain `waiting`).
 *   none        — unknown / no signal yet → no icon.
 *
 * CRITICAL (the bug this fixes): `review` is valid ONLY while a session's CURRENT
 * state is idle. If the agent starts working again before the user looks, the newer
 * `working` supersedes the stale review flag — a session that is currently working
 * (or needs input) is never shown as ready-for-review. `needsInput` also outranks
 * `review`: a blocked session demands action before a finished sibling wants a look.
 */

export type DisplayState = 'needsInput' | 'review' | 'working' | 'idle' | 'none'

/** Display priority, highest → lowest. Higher wins the task rollup (§3.4/§9.5). */
export const DISPLAY_RANK: Readonly<Record<DisplayState, number>> = {
  none: 0,
  idle: 1,
  working: 2,
  review: 3,
  needsInput: 4
}
