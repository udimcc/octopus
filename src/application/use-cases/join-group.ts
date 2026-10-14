/**
 * `joinGroup` use case (DESIGN §5.7 tab-menu "Split right / Split down", and
 * the split shortcut's resulting command). `Task.join` forms a new group (or
 * extends the anchor's existing one), moving `sessionId`'s tab to right after
 * the anchor's — ALWAYS an order change, since a freshly-formed group's new
 * leaf cannot already be adjacent. Persist the (possibly renumbered) session
 * rows the same way `reorderSession` does, persist the group diff via
 * `persistGroups`, and publish `groupsChanged` with the task's full group list
 * plus `sessionReordered` with the resulting tab order.
 */

import type { AppDependencies } from '../dependencies'
import type { JoinGroupInput } from '../commands'
import { locateSession } from './locate-session'
import { persistGroups } from './persist-groups'
import { InvariantViolationError } from '../../domain/errors'

export function joinGroup(deps: AppDependencies, input: JoinGroupInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    throw new InvariantViolationError(`session ${input.sessionId} not found`)
  }
  const { task } = located

  const before = task.groups()
  task.join(input.sessionId, input.anchorSessionId, input.dir, deps.ids.newGroupId())
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
