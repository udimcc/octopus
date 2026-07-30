/**
 * `switchSession` use case (DESIGN §3.3, §5.4). Moves a task's active-session
 * pointer (which tab is visible) to the given session, persists it, and emits
 * `activeSessionChanged` to ALL windows.
 *
 * Why this exists (Bug: `Ctrl+Shift+Arrow` didn't switch sessions across windows):
 * a task's sessions can be hosted in different windows (§6.7), yet the active-tab
 * cycle was a renderer-local store mutation — landing on a session in another window
 * did nothing visible and never told that window. Routing the switch through the
 * loop lets us broadcast one event: every window updates its `activeSessionByTask`
 * pointer, and the window that HOSTS the target (carried as `windowId`) raises itself
 * to the OS foreground (done in the composition root, which owns `BrowserWindow`).
 *
 * NO session lifecycle changes — switching is purely visibility, mirroring
 * `switchTask` (I9). A no-op switch (target already the task's active session) still
 * emits, so a keystroke always brings the hosting window forward.
 */

import type { AppDependencies } from '../dependencies'
import type { SwitchSessionInput } from '../commands'
import { InvariantViolationError } from '../../domain/errors'
import { locateSession } from './locate-session'

export function switchSession(deps: AppDependencies, input: SwitchSessionInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    throw new InvariantViolationError(`session ${input.sessionId} not found`)
  }
  const { task, session } = located

  // Move the persisted active-session pointer (I10). Skip the write when unchanged,
  // but still emit below so the hosting window is raised on every keystroke.
  if (task.activeSessionId !== session.id) {
    task.setActiveSession(session.id)
    deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
  }

  deps.bus.publish({
    type: 'activeSessionChanged',
    taskId: task.id,
    sessionId: session.id,
    windowId: session.windowId
  })
}
