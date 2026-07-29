/**
 * `getSessionCwd` read-model query (DESIGN §5.2, §6.5). Resolves the live current
 * working directory of a session's running process — where a terminal has `cd`'d
 * to — so the UI can open a new session in the same directory.
 *
 * Like `getState`, this is a pure READ of live state that bypasses the single-writer
 * command loop (it mutates no aggregate): it reads the runtime handle straight from
 * `deps.runtimes` and delegates to the runtime's optional `currentCwd` seam. Returns
 * `undefined` when the session has no live runtime, or the runtime can't observe a
 * cwd (exited process, non-terminal type, non-Linux, daemon unreachable).
 */

import type { AppDependencies } from '../dependencies'
import type { SessionId } from '../../domain/ids'

export async function getSessionCwd(
  deps: AppDependencies,
  sessionId: SessionId
): Promise<string | undefined> {
  const runtime = deps.runtimes.get(sessionId)
  return runtime?.currentCwd?.()
}
