/**
 * `resizeGroup` use case (DESIGN §5.7, divider drag released). `Task.resizeGroup`
 * sets one split node's ratio (clamped 0.1–0.9); no membership or order change —
 * the renderer previews the drag locally and sends exactly one resize per
 * release (§5.7 "Divider drag"). Persist the group diff (`persistGroups` upserts
 * every surviving group of the task, not just this one — cheaper than diffing
 * tree/color field by field — but no group id ever disappears from a resize) and
 * publish `groupsChanged` only.
 */

import type { AppDependencies } from '../dependencies'
import type { ResizeGroupInput } from '../commands'
import { persistGroups } from './persist-groups'
import { InvariantViolationError } from '../../domain/errors'

export function resizeGroup(deps: AppDependencies, input: ResizeGroupInput): void {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  const before = task.groups()
  task.resizeGroup(input.groupId, input.path, input.ratio)
  const after = task.groups()

  // Wrapped (review#3) so a multi-group task's upserts can't partially land.
  deps.persistence.transaction(() => {
    persistGroups(deps.persistence, task.id, before, after)
  })
  deps.bus.publish({ type: 'groupsChanged', taskId: task.id, groups: after })
}
