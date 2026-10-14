/**
 * `bindIssue` use case (DESIGN "Issues" §13.3, I19). Binds an issue to a task
 * (1:1); `Workspace.bindIssue` replaces the issue's prior binding (if any) and
 * moves `Todo` → `InProgress` in the same mutation. Rejects a task already
 * connected to a different issue (see below) rather than stealing it.
 *
 * Two checks are pre-validated HERE, as `{ ok: false }`, rather than left to
 * throw out of `Workspace.bindIssue`:
 *
 *   - A task whose lifecycle means no `tasks` row exists yet —
 *     `None`/`Provisioning`/`ProvisionFailed` (see `create-task.ts`: a task is
 *     persisted only once it reaches `Ready`, including the repo-less "none"
 *     mode) — because `issues.task_id` is an FK that needs a row to point at.
 *     Every other lifecycle (`Ready`, `Stale`, `Deleting`, `DeleteFailed`) was
 *     persisted at some point and keeps its row, so binding is allowed.
 *   - A task already bound to a DIFFERENT issue, with the user-facing message
 *     "already linked" — `Workspace.bindIssue` enforces the same rule, but
 *     its own `InvariantViolationError` message is written for an internal
 *     audience (`I19`); pre-checking here keeps the `CommandResult.error` the
 *     text a user should see.
 *
 * Binding this issue to the task it is ALREADY bound to is a deliberate no-op
 * (`{ ok: true }`, no write, no status flip, no event): there is nothing to
 * change, and re-running the Todo → InProgress automation on an unrelated
 * re-bind would be surprising.
 *
 * The actual bind + persist run inside one transaction (mirrors `createTask`'s
 * "mutate domain + persist" transactions), but better-sqlite3's transaction
 * only rolls back the SQL side — it does nothing to `Workspace`'s in-memory
 * mutation. So on a persist failure we restore the issue's prior binding/status
 * via `Workspace.restoreIssueBinding` before rethrowing, keeping memory and disk
 * from diverging (the same method `create-task.ts`'s `persistReadyTask` rollback
 * uses, so every binding-state restore after a persist failure goes through one
 * place instead of each call site poking `Issue.bindTo`/`clearBinding` itself).
 */

import type { AppDependencies } from '../dependencies'
import type { BindIssueInput, CommandResult } from '../commands'
import { TaskLifecycle } from '../../domain/lifecycle'

/** Lifecycles with no `tasks` row yet (I19 FK requirement). */
const NOT_YET_PERSISTED: ReadonlySet<TaskLifecycle> = new Set([
  TaskLifecycle.None,
  TaskLifecycle.Provisioning,
  TaskLifecycle.ProvisionFailed
])

export function bindIssue(deps: AppDependencies, input: BindIssueInput): CommandResult {
  const issue = deps.workspace.issue(input.issueId)
  if (!issue) {
    return { ok: false, error: `issue ${input.issueId} not found` }
  }
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    return { ok: false, error: `task ${input.taskId} not found` }
  }
  if (NOT_YET_PERSISTED.has(task.lifecycle)) {
    return { ok: false, error: `task ${input.taskId} is not ready to be linked to an issue yet` }
  }

  // Already bound to this exact task: nothing to do (see module doc).
  if (issue.taskId === input.taskId) {
    return { ok: true }
  }

  const boundElsewhere = deps.workspace.issueForTask(input.taskId)
  if (boundElsewhere && boundElsewhere.id !== input.issueId) {
    return { ok: false, error: 'already linked' }
  }

  const priorTaskId = issue.taskId
  const priorStatus = issue.status
  try {
    deps.persistence.transaction(() => {
      deps.workspace.bindIssue(input.issueId, input.taskId)
      deps.persistence.upsertIssue(issue.toSnapshot())
    })
  } catch (err) {
    // Restore the already-validated prior state via `Workspace.restoreIssueBinding`
    // (not `Workspace.bindIssue`, which would re-run the 1:1 check and status
    // automation against state that never actually changed on disk) — only
    // `Workspace` is meant to touch `Issue.bindTo`/`clearBinding` (I19).
    deps.workspace.restoreIssueBinding(input.issueId, priorTaskId, priorStatus)
    throw err
  }
  // `updatedAt` is deliberately left untouched: binding is not an edit to the
  // issue's own content, so `issue.touch()` is never called here.
  deps.bus.publish({ type: 'issueUpserted', issue: issue.toSnapshot() })
  return { ok: true }
}
