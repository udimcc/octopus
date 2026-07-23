/**
 * `switchTask` use case (DESIGN §3.3, §5.3, §6.3, I9). Two concerns:
 *
 *   1. **Visibility (I9):** move the active-task pointer + persist it, then emit
 *      `activeTaskChanged`. NO session lifecycle changes on a switch — background
 *      sessions keep running; switching is purely which `TaskView` is visible. If
 *      the target is already active, the pointer/event are skipped.
 *
 *   2. **Lazy runtime start (§6.3 Restore):** start the fresh PTYs of the target
 *      task's still-`Created` sessions (restored-from-disk definitions that have no
 *      runtime yet). This runs on EVERY switch — including the renderer's mount-time
 *      switch to the initially-active task — and is idempotent (already-Running
 *      sessions are skipped), so it bounds startup PTYs to tasks the user actually
 *      opens.
 *
 * Runs on the single writer, so the (async) session starts are serialized with
 * every other mutation (§6.6).
 */

import type { AppDependencies } from '../dependencies'
import type { SwitchTaskInput } from '../commands'
import { InvariantViolationError } from '../../domain/errors'
import { startTaskSessions } from './start-task-sessions'

export async function switchTask(deps: AppDependencies, input: SwitchTaskInput): Promise<void> {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  // Move the pointer only if it actually changes (I9); the event follows.
  if (deps.workspace.activeTaskId !== input.taskId) {
    deps.workspace.setActiveTask(input.taskId)
    deps.persistence.setActiveTask(input.taskId)
    deps.bus.publish({ type: 'activeTaskChanged', taskId: input.taskId })
  }

  // Lazily start any restored sessions of the now-visible task (idempotent).
  await startTaskSessions(deps, input.taskId)
}
