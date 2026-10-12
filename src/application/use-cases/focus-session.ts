/**
 * `focusSession` use case (DESIGN §5.4, I10). Records a session as its task's "last
 * focused session" — the persisted `task.activeSessionId` — and NOTHING else.
 *
 * Each window keeps its OWN marked (displayed) tab per task in the renderer; "the
 * focused session" is the marked tab of the OS-focused window. The renderer sends
 * this whenever that changes (a tab click, a window gaining focus, …) so the pointer
 * survives restart. It is fire-and-forget: a session that's no longer found (the
 * report raced a close) is silently ignored rather than surfaced as an error.
 *
 * Why this is NOT `switchSession`: a switch publishes `activeSessionChanged`, which
 * re-points the HOST window's mark and raises that window. Reusing it for focus would
 * broadcast and raise on every focus change — and in a cross-window keyboard switch
 * (`Ctrl+Shift+Arrow`) the OS focus event of the raised window can land BEFORE its
 * `activeSessionChanged`, so it would report the OLD mark as a switch and flip the
 * host straight back. A persist-only write has no such feedback loop: if it lands
 * out of order, the next focus report simply overwrites it (eventually consistent).
 *
 * NO session lifecycle changes and NO bus event — the renderer already shows the
 * mark it is reporting.
 */

import type { AppDependencies } from '../dependencies'
import type { FocusSessionInput } from '../commands'
import { locateSession } from './locate-session'

export function focusSession(deps: AppDependencies, input: FocusSessionInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    // Raced a close (fire-and-forget report): nothing to persist.
    return
  }
  const { task, session } = located

  // Skip the write when the pointer is already there (focus reports repeat often).
  if (task.activeSessionId === session.id) {
    return
  }
  task.setActiveSession(session.id)
  deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
}
