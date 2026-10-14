/**
 * `reorderSession` use case (DESIGN §3.2, §5.4). Moves a session tab within its
 * task; `Task.reorderSession` renumbers every session's dense `order`. Persist
 * all affected session rows in one transaction and announce the new tab order.
 *
 * Since DESIGN §5.7, `Task.reorderSession` may clamp/snap `input.toIndex` to a
 * different ACTUAL index — a group member is clamped to its own group's span,
 * and a lone tab dropped inside a group snaps to that group's nearer edge. No
 * change was needed here to honor that: `ordered` is read via `task.sessions()`
 * AFTER the mutation runs, so it (and the `sessionReordered` it publishes)
 * already reflects the real resulting order, never the raw requested index.
 */

import type { AppDependencies } from '../dependencies'
import type { ReorderSessionInput } from '../commands'
import { InvariantViolationError } from '../../domain/errors'

export function reorderSession(deps: AppDependencies, input: ReorderSessionInput): void {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  task.reorderSession(input.sessionId, input.toIndex)

  const ordered = task.sessions()
  deps.persistence.transaction(() => {
    for (const s of ordered) {
      deps.persistence.upsertSession(s.toSnapshot())
    }
  })

  deps.bus.publish({
    type: 'sessionReordered',
    taskId: input.taskId,
    orderedSessionIds: ordered.map((s) => s.id)
  })
}
