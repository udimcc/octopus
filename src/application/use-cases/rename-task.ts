/**
 * `renameTask` use case (DESIGN §3.1, §6.5). Renames the display name only — the
 * worktree (and its branch) is immutable once Ready (I2), so a rename never
 * touches the worktree. Persist the new name and announce it.
 */

import type { AppDependencies } from '../dependencies'
import type { RenameTaskInput } from '../commands'
import { InvariantViolationError } from '../../domain/errors'

export function renameTask(deps: AppDependencies, input: RenameTaskInput): void {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  task.rename(input.name)
  deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
  deps.bus.publish({ type: 'taskRenamed', taskId: input.taskId, name: input.name })
}
