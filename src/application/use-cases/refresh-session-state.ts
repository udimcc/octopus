/**
 * `refreshSessionState` (DESIGN §5.4 R1, §9.6). The "Refresh state" affordance:
 * the user asks a session to re-evaluate its state NOW (e.g. after the automatic
 * signals drifted, or to nudge a stuck icon). Like {@link writeToPty} it touches a
 * LIVE runtime, not the aggregate, but still flows through the single-writer loop
 * so it orders correctly against close/create (§6.6).
 *
 * Best-effort and silent: a session with no runtime (already closed) or whose
 * runtime lacks a state evaluator (a Terminal without integration, or state
 * detection opted out) is a no-op — `refresh?.()` simply doesn't fire. The refresh
 * result, if any, comes back asynchronously as an ordinary `ingestSessionState`
 * through the evaluator's push callback, so this emits no event itself.
 */

import type { AppDependencies } from '../dependencies'
import type { RefreshSessionStateInput } from '../commands'

export function refreshSessionState(deps: AppDependencies, input: RefreshSessionStateInput): void {
  const runtime = deps.runtimes.get(input.sessionId)
  runtime?.stateEvaluator()?.refresh?.()
}
