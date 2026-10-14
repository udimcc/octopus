/**
 * `leaveGroup` use case (DESIGN §5.7 tab-menu "Remove from group"). `Task.leave`
 * removes `sessionId`'s leaf (dissolving the group if 1 member remains) and
 * moves its tab to right after the (remaining) group's block — ALWAYS an order
 * change. Persist session rows + the group diff, publish `groupsChanged` with
 * the task's full group list and `sessionReordered` with the resulting order,
 * same pattern as `joinGroup`.
 *
 * `Task.leave` throws `InvariantViolationError` if `sessionId` isn't currently
 * in a group; that's a domain error and surfaces to the caller as `{ ok: false
 * }` via the command loop, same as any other invariant violation.
 */

import type { AppDependencies } from '../dependencies'
import type { LeaveGroupInput } from '../commands'
import { locateSession } from './locate-session'
import { persistGroups } from './persist-groups'
import { InvariantViolationError } from '../../domain/errors'

export function leaveGroup(deps: AppDependencies, input: LeaveGroupInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    throw new InvariantViolationError(`session ${input.sessionId} not found`)
  }
  const { task } = located

  const before = task.groups()
  task.leave(input.sessionId)
  const after = task.groups()

  const ordered = task.sessions()
  deps.persistence.transaction(() => {
    for (const s of ordered) {
      deps.persistence.upsertSession(s.toSnapshot())
    }
    persistGroups(deps.persistence, task.id, before, after)
  })

  deps.bus.publish({ type: 'groupsChanged', taskId: task.id, groups: after })
  deps.bus.publish({
    type: 'sessionReordered',
    taskId: task.id,
    orderedSessionIds: ordered.map((s) => s.id)
  })
}
