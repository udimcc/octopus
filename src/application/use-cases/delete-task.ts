/**
 * `deleteTask` use case (DESIGN §6.6 strict-order, I3, I4). The teardown order is
 * enforced HERE, in the `Deleting` state — never in the UI:
 *
 *   1. Resolve the task; a force-forget (Stale/DeleteFailed) short-circuits the
 *      whole sequence and just removes the record (I4).
 *   2. Dirty gate: if the worktree has uncommitted changes and the user hasn't
 *      confirmed (and it isn't a force), return `{ needsDirtyConfirm: true }` and
 *      STOP — nothing is torn down (§6.6, §6.4).
 *   3. `markDeleting` → stop & dispose ALL session runtimes (SIGHUP→grace→SIGKILL
 *      in the runtime) so nothing holds an fd in the worktree (§6.4).
 *   4. Run the delete script; on failure still remove the task (+ scriptError) —
 *      the user asked to delete (I4).
 *   5. Remove rows in ONE transaction, drop the task from the workspace, emit
 *      `taskDeleted` (+ `activeTaskChanged` if it was active).
 *
 * Runs on the single writer, so no create/switch interleaves mid-teardown (§6.6).
 */

import type { AppDependencies } from '../dependencies'
import type { DeleteTaskInput, CommandResult } from '../commands'
import { TaskLifecycle } from '../../domain/lifecycle'

export async function deleteTask(
  deps: AppDependencies,
  input: DeleteTaskInput
): Promise<CommandResult> {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    // Idempotent: deleting an already-gone task is a success (I4).
    return { ok: true }
  }

  const worktree = task.worktree

  // Force-forget path (I4): a Stale or ProvisionFailed/DeleteFailed task, or an
  // explicit force, is removed without running the script (nothing to tear down
  // safely, or the user insisted).
  const forceForget =
    input.force === true ||
    task.lifecycle === TaskLifecycle.Stale ||
    task.lifecycle === TaskLifecycle.ProvisionFailed ||
    task.lifecycle === TaskLifecycle.DeleteFailed

  // Dirty gate (§6.6 step 2) — only meaningful for a Ready task with a worktree,
  // and skipped on force-forget.
  if (!forceForget && worktree && input.confirmedDirty !== true) {
    const dirty = await deps.worktrees.isDirty(worktree.path)
    if (dirty) {
      return { ok: false, needsDirtyConfirm: true }
    }
  }

  const wasActive = deps.workspace.activeTaskId === input.taskId

  if (!forceForget) {
    task.markDeleting()
  }

  // Step 3: stop & dispose every runtime for this task's sessions (§6.4).
  for (const session of task.sessions()) {
    const runtime = deps.runtimes.get(session.id)
    if (runtime) {
      try {
        await runtime.stop()
      } catch {
        // A stop failure must not block teardown; force-dispose below.
      }
      runtime.dispose()
      deps.runtimes.delete(session.id)
    }
  }

  // Step 4: remove the worktree (skipped on force-forget or if never Ready). Use
  // the task's OWN stored repo directory (`provisionedBy.repoRoot`), not a global
  // — different tasks target different repos, and this survives a restart (§6.4).
  if (!forceForget && worktree) {
    try {
      await deps.worktrees.remove({
        taskId: input.taskId,
        taskName: task.name,
        path: worktree.path,
        repoDir: worktree.provisionedBy.repoRoot,
        confirmedDirty: input.confirmedDirty
      })
    } catch (err) {
      // Spawn failure (ENOENT) or safety refusal: keep the record so the user can
      // retry / force-forget (I4), surface the error, and STOP.
      task.markDeleteFailed()
      const message = err instanceof Error ? err.message : String(err)
      deps.bus.publish({
        type: 'scriptError',
        taskId: input.taskId,
        script: 'delete_worktree',
        exitCode: null,
        stderr: message
      })
      return { ok: false, error: message }
    }
  }

  // Step 5: remove rows + workspace entry atomically, then announce.
  deps.persistence.transaction(() => {
    deps.persistence.deleteTask(input.taskId) // sessions cascade via FK (§6.3)
    deps.workspace.removeTask(input.taskId)
    if (wasActive) {
      deps.persistence.setActiveTask(deps.workspace.activeTaskId)
    }
  })

  deps.bus.publish({ type: 'taskDeleted', taskId: input.taskId })
  if (wasActive) {
    deps.bus.publish({ type: 'activeTaskChanged', taskId: deps.workspace.activeTaskId })
  }
  return { ok: true }
}
