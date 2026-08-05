/**
 * `refreshSessionState` (DESIGN §5.4 R1, §9.6). The "Refresh state" affordance: the
 * user asks a session to re-evaluate its state NOW (e.g. to nudge a stale icon).
 * Flows through the single-writer loop so it orders correctly against close/create
 * (§6.6).
 *
 * State detection is file-based now (§9.6): the Claude python bridge writes each
 * session's state file, and the composition-root watcher feeds `ingestSessionState`.
 * "Refresh" therefore asks the watcher to RE-READ this session's file and re-emit —
 * `deps.refreshClaudeState(sessionId)` → `watcher.rescan(...)`. Best-effort and
 * silent: absent sink (detection opted out) is a no-op, and the re-emit, if any,
 * arrives asynchronously as an ordinary `ingestSessionState`, so this emits no event.
 */

import type { AppDependencies } from '../dependencies'
import type { RefreshSessionStateInput } from '../commands'

export function refreshSessionState(deps: AppDependencies, input: RefreshSessionStateInput): void {
  deps.refreshClaudeState?.(input.sessionId)
}
