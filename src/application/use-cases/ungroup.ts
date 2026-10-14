/**
 * `ungroup` use case (DESIGN §5.7 group-line menu "Ungroup"). `Task.ungroup`
 * drops the group entirely — every member becomes lone, tabs stay exactly where
 * they are (no `reorderSession`/order change, unlike join/leave). Persist the
 * group diff (`deleteGroup` for the dissolved group, plus an `upsertGroup` for
 * every OTHER group still surviving — `persistGroups` always upserts the whole
 * survivor list, not just the one changed here) and publish `groupsChanged` with
 * the task's remaining group list.
 */

import type { AppDependencies } from '../dependencies'
import type { UngroupInput } from '../commands'
import { persistGroups } from './persist-groups'
import { InvariantViolationError } from '../../domain/errors'

export function ungroup(deps: AppDependencies, input: UngroupInput): void {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  const before = task.groups()
  task.ungroup(input.groupId)
  const after = task.groups()

  // Wrapped (review#3) so a crash mid-write can't leave the deleted group's row
  // persisted while a surviving group's upsert already landed, or vice versa —
  // `persistGroups` issues one statement per group, not a single multi-row write.
  deps.persistence.transaction(() => {
    persistGroups(deps.persistence, task.id, before, after)
  })
  deps.bus.publish({ type: 'groupsChanged', taskId: task.id, groups: after })
}
