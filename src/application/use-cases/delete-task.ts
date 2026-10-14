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
 *   5. Remove rows in ONE SQL transaction; once it COMMITS, apply the matching
 *      in-memory drop (`workspace.removeTask`/`removeIssue`), then emit
 *      `taskDeleted` (+ `activeTaskChanged` if it was active).
 *
 * Runs on the single writer, so no create/switch interleaves mid-teardown (§6.6).
 *
 * **Issue unbind/delete ("Issues" §13.3, I19).** Applied ONLY alongside step 5's
 * transaction, the task's actual removal — never on the dirty-gate return, a
 * delete-script failure, or the already-gone no-op above, all of which leave the
 * issue (and its binding) untouched, mirroring the task's own all-or-nothing
 * delete (I3/I4). Applies identically to the force-forget path: it still reaches
 * step 5, and a force-forgotten task's bound issue needs the same treatment.
 * With `alsoDeleteIssue`, the issue row is deleted outright; without it, the
 * now-unbound issue snapshot (`taskId` explicitly set `undefined`, mirroring
 * `unbind-issue.ts`) is persisted so the DB mirrors the real `ON DELETE SET NULL`
 * the task row delete just fired on it. The in-memory mutations
 * (`workspace.removeTask`/`removeIssue`) run only AFTER the SQL transaction
 * commits — not inside its callback — since better-sqlite3's rollback on a
 * later statement throwing undoes only the SQL side, never an in-memory
 * mutation that already ran inside the callback (the same reasoning
 * `bind-issue.ts`/`create-task.ts` document for their own rollback paths, just
 * applied by reordering instead of restoring).
 */

import type { AppDependencies } from '../dependencies'
import type { DeleteTaskInput, CommandResult } from '../commands'
import type { IssueId } from '../../domain/ids'
import type { IssueSnapshot } from '../../domain/snapshots'
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
  // An ADOPTED worktree (`managed === false`, "From Existing Repo") is left on disk:
  // Octopus did not create it, so deleting the task must not remove the directory.
  if (!forceForget && worktree && worktree.managed) {
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

  // Resolve the bound issue (if any) BEFORE tearing anything down — the dirty
  // gate / script failure returns above never reach here, so they leave it alone.
  const issue = deps.workspace.issueForTask(input.taskId)
  // Precompute the unbound snapshot (mirrors `unbind-issue.ts`) from the issue's
  // CURRENT in-memory state, since `workspace.removeTask` (which also clears
  // this binding) only runs after the SQL transaction below commits.
  const unboundIssueSnapshot: IssueSnapshot | undefined =
    issue && !input.alsoDeleteIssue ? { ...issue.toSnapshot(), taskId: undefined } : undefined

  // Step 5: remove rows atomically. Applies to both the normal and
  // force-forget paths — both land here as the task's actual removal (I19).
  // SQL only — no `Workspace` mutation inside the callback, so a later
  // statement throwing rolls back every row this transaction touched without
  // leaving memory ahead of disk (see module doc).
  deps.persistence.transaction(() => {
    deps.persistence.deleteTask(input.taskId) // sessions cascade via FK (§6.3)
    if (wasActive) {
      // The task being removed was the active one; `removeTask` below only
      // ever clears the pointer (it never picks a replacement), so the new
      // active task id is unconditionally `undefined`.
      deps.persistence.setActiveTask(undefined)
    }
    if (issue) {
      if (input.alsoDeleteIssue) {
        deps.persistence.deleteIssue(issue.id)
      } else if (unboundIssueSnapshot) {
        deps.persistence.upsertIssue(unboundIssueSnapshot)
      }
    }
  })

  // The SQL transaction committed — now apply the matching in-memory drop.
  deps.workspace.removeTask(input.taskId) // also clears the issue's binding in memory (I19)
  let deletedIssueId: IssueId | undefined
  let upsertedIssue: IssueSnapshot | undefined
  if (issue) {
    if (input.alsoDeleteIssue) {
      deps.workspace.removeIssue(issue.id)
      deletedIssueId = issue.id
    } else {
      upsertedIssue = unboundIssueSnapshot
    }
  }

  deps.bus.publish({ type: 'taskDeleted', taskId: input.taskId })
  if (wasActive) {
    deps.bus.publish({ type: 'activeTaskChanged', taskId: deps.workspace.activeTaskId })
  }
  if (deletedIssueId) {
    deps.bus.publish({ type: 'issueDeleted', issueId: deletedIssueId })
  } else if (upsertedIssue) {
    deps.bus.publish({ type: 'issueUpserted', issue: upsertedIssue })
  }
  return { ok: true }
}
