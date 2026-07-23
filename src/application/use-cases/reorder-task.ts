/**
 * `reorderTask` use case (DESIGN §3.1, §5.1). Moves a task in the progress-panel
 * order; `Workspace.reorderTask` renumbers every task's dense `position`. Persist
 * all affected task rows in one transaction and announce the new order so the UI
 * can settle its drag (§6.6).
 */

import type { AppDependencies } from '../dependencies'
import type { ReorderTaskInput } from '../commands'
import { InvariantViolationError } from '../../domain/errors'

export function reorderTask(deps: AppDependencies, input: ReorderTaskInput): void {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  deps.workspace.reorderTask(input.taskId, input.toIndex)

  const ordered = deps.workspace.tasks()
  // Positions changed across (potentially) many rows; persist them together.
  deps.persistence.transaction(() => {
    for (const t of ordered) {
      deps.persistence.upsertTask(t.toSnapshot(deps.aggregator))
    }
  })

  deps.bus.publish({
    type: 'taskReordered',
    orderedTaskIds: ordered.map((t) => t.id)
  })
}
