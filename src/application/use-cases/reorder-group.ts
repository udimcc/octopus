/**
 * `reorderGroup` use case (DESIGN §5.7, dragging the group line within the tab
 * bar). `Task.reorderGroup` moves the WHOLE member block to a new index
 * (snapped so it never lands inside another group), renumbering every
 * session's dense `order` — an order change, like `reorderSession`, but the
 * group's own tree/color is untouched. Persist the renumbered session rows and
 * publish `sessionReordered` with the resulting order; also publish
 * `groupsChanged` with the task's (unchanged) full group list, per the uniform
 * "every group use case announces the current group list" rule the other four
 * use cases follow — cheap, since nothing moved.
 */

import type { AppDependencies } from '../dependencies'
import type { ReorderGroupInput } from '../commands'
import { InvariantViolationError } from '../../domain/errors'

export function reorderGroup(deps: AppDependencies, input: ReorderGroupInput): void {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  task.reorderGroup(input.groupId, input.toIndex)

  const ordered = task.sessions()
  deps.persistence.transaction(() => {
    for (const s of ordered) {
      deps.persistence.upsertSession(s.toSnapshot())
    }
  })

  deps.bus.publish({ type: 'groupsChanged', taskId: task.id, groups: task.groups() })
  deps.bus.publish({
    type: 'sessionReordered',
    taskId: task.id,
    orderedSessionIds: ordered.map((s) => s.id)
  })
}
