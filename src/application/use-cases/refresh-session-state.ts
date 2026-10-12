/**
 * `refreshSessionState` (DESIGN §5.4 R1, §9.6). The "Refresh state" affordance: the
 * user asks a session to re-evaluate its state NOW (e.g. to nudge a stale icon).
 * Flows through the single-writer loop so it orders correctly against close/create
 * (§6.6).
 *
 * State detection is file-based (§9.6): the Claude hook recorder appends to each
 * session's events log, and the composition-root watcher feeds `ingestSessionState`.
 * "Refresh" therefore asks the watcher to RE-FOLD this session's log and re-emit —
 * `deps.refreshClaudeState(sessionId)` → `watcher.rescan(...)`. Best-effort and
 * silent: absent sink (detection opted out) is a no-op, and the re-emit, if any,
 * arrives asynchronously as an ordinary `ingestSessionState`, so this emits no event.
 */

import type { AppDependencies } from '../dependencies'
import type { RefreshSessionStateInput } from '../commands'

export function refreshSessionState(deps: AppDependencies, input: RefreshSessionStateInput): void {
  deps.refreshClaudeState?.(input.sessionId)
}
