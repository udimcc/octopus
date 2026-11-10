/**
 * `createTask` use case (DESIGN §3.5, §6.4). Drives a task None → Provisioning →
 * Ready, running the create script through the `WorktreeProvider` behind the
 * scenes and persisting only once the worktree is validated.
 *
 * Sequence:
 *   1. Create the task (`None`), mark `Provisioning`, add to workspace, emit
 *      `taskCreated` (Provisioning) so the UI can show a spinner immediately.
 *   2. Run the create script; stream stderr as `scriptProgress` events (§6.4).
 *   3. On success: build a `WorktreeRef`, `markReady`, provision the (dormant)
 *      per-session socket dir, persist the task in a transaction, set it active,
 *      and emit `taskCreated` (Ready) + `activeTaskChanged`.
 *   4. On a PROVISIONING failure (the script/git step itself): `markProvisionFailed`,
 *      best-effort rollback via the delete script, emit `scriptError`. The task
 *      record is kept in `ProvisionFailed` so the UI can offer Retry / force-forget
 *      (§3.5) — it is NOT persisted (only `Ready` tasks reach the DB, matching
 *      `taskToRow`'s worktree guard).
 *   5. On a PERSIST failure (step 3's transaction, after `markReady` already ran):
 *      a DIFFERENT path from step 4 — see `persistReadyTask` below. The task has
 *      already left `Provisioning` for `Ready` in memory, so `markProvisionFailed`
 *      is not a legal move (`Ready` only transitions to `Deleting`/`Stale`); calling
 *      it anyway would throw `IllegalTransitionError` and mask the real persistence
 *      error. Instead the in-memory add is rolled all the way back out, a
 *      `taskDeleted` event undoes the `taskCreated` (Provisioning) the UI already
 *      received, and the real error comes back as `{ ok: false, error }`. Note this
 *      path only rolls back `Workspace`/DB state: for a `managed` worktree, the
 *      directory and new branch were already created on disk by step 2 before the
 *      persist failure, so they are left orphaned there — the same "cleanup is the
 *      script's/git's own concern" posture as step 4's partial-provisioning cleanup
 *      above, not something this use case removes.
 *
 * The whole thing runs inside the single-writer loop, so no other mutation
 * interleaves while the (slow) script runs — the workspace is consistent
 * throughout (§6.6).
 *
 * **Issue binding ("Issues" §13.3, I19).** When `input.issueId` is set, the bind
 * happens in the SAME persist transaction as the Ready task's `upsertTask` — not
 * at `Provisioning` — so a provisioning failure (step 4) leaves the issue
 * completely untouched. `bindRequestedIssue`'s "no longer exists" / "bound to a
 * different task" checks are a STALE-VIEW guard, not a concurrency guard: the
 * single-writer loop already serializes commands, so nothing can rebind the
 * issue WHILE this command runs (including across the slow provisioning await).
 * What they guard against is `input.issueId` itself being stale — the New-Task
 * modal read the issue picker's list, the user picked one, and only THEN did this
 * command get dispatched and reach the front of the loop; another window's
 * command (bind/delete) can land in that gap, before this command ever starts. If
 * so, the task is still created (unbound) and an `error` toast explains why,
 * rather than throwing or stealing the binding (`Workspace.bindIssue` itself
 * throws on either case, so this guards ahead of calling it). `issueUpserted` is
 * published AFTER `taskCreated` so the renderer always learns about the task
 * before the issue that now points at it.
 */

import type { AppDependencies } from '../dependencies'
import type {
  CreateTaskInput,
  CreateTaskFromNewInput,
  CreateTaskFromExistingInput,
  CommandResult
} from '../commands'
import type { TaskId, IssueId } from '../../domain/ids'
import type { IssueSnapshot } from '../../domain/snapshots'
import { Task } from '../../domain/task'
import { WorktreeRef } from '../../domain/worktree-ref'

/** The outcome of a bind attempt, for the caller to announce after its transaction. */
interface BindOutcome {
  readonly boundIssue?: IssueSnapshot
  readonly errorMessage?: string
}

/**
 * Bind `issueId` (if given) to `taskId`, persisting the issue — called from
 * INSIDE the Ready persist transaction, never during Provisioning (see module
 * doc). A missing or already-bound-elsewhere issue means `input.issueId` was
 * already stale when this command was dispatched (see module doc); it is left
 * untouched and the caller publishes `errorMessage` as an `error` toast instead
 * of binding.
 */
function bindRequestedIssue(
  deps: AppDependencies,
  issueId: IssueId | undefined,
  taskId: TaskId
): BindOutcome {
  if (!issueId) {
    return {}
  }
  const issue = deps.workspace.issue(issueId)
  if (!issue) {
    return { errorMessage: 'Issue no longer exists; task created without it' }
  }
  // Unbound, or (defensively) already bound to this very task: safe to bind.
  // Bound to a different task: that bind landed before this command reached
  // the front of the loop (the stale-view gap described in the module doc) —
  // leave it alone and explain why in a toast.
  if (issue.taskId !== undefined && issue.taskId !== taskId) {
    return { errorMessage: 'Issue was linked to another task; task created without it' }
  }
  deps.workspace.bindIssue(issueId, taskId)
  const boundIssue = issue.toSnapshot()
  deps.persistence.upsertIssue(boundIssue)
  return { boundIssue }
}

/** Publish `issueUpserted`/`error` for a bind attempt's outcome, after `taskCreated`. */
function announceBindOutcome(deps: AppDependencies, taskId: TaskId, outcome: BindOutcome): void {
  if (outcome.boundIssue) {
    deps.bus.publish({ type: 'issueUpserted', issue: outcome.boundIssue })
  } else if (outcome.errorMessage) {
    deps.bus.publish({ type: 'error', taskId, message: outcome.errorMessage })
  }
}

/** The outcome of {@link persistReadyTask}. */
type PersistReadyOutcome = { ok: true; bindOutcome: BindOutcome } | { ok: false; error: string }

/**
 * Persist an already-`Ready` task (built by either the "none" mode or the
 * provisioning modes' `markReady`), make it active, and bind the requested
 * issue — all in one transaction (§6.6, §13.3).
 *
 * This is a PERSIST failure, not a provisioning failure (the caller decides
 * what "provisioning" even means for its mode) — see the module doc. On
 * failure here, better-sqlite3's transaction only rolled back the SQL side;
 * `Workspace`'s in-memory mutations from this same transaction are still
 * live, so we restore them ourselves (mirrors `bindIssue`'s capture-before /
 * restore-after pattern) rather than leaving a `Ready` task — and possibly a
 * bound/`InProgress` issue — in memory that was never written to disk:
 *
 *   - `removeTask` drops the task and clears its active-task pointer if it was
 *     just made active; it also clears the binding of any issue bound to it,
 *     which covers `bindRequestedIssue`'s mutation of `issue.taskId`.
 *   - The active-task pointer is then explicitly restored to whatever it was
 *     before this call (`removeTask` only clears it, it doesn't know what to
 *     put back).
 *   - The requested issue's binding/status is restored via
 *     `Workspace.restoreIssueBinding` (the same method `bind-issue.ts`'s own
 *     rollback uses) with the taskId captured before the transaction ran —
 *     `removeTask`'s unbind already cleared `issue.taskId` above, so this call
 *     is a no-op on that front, but routing it through one shared method keeps
 *     every binding-state restore in one place rather than each call site
 *     poking `Issue.bindTo`/`clearBinding`/`setStatus` directly.
 */
function persistReadyTask(
  deps: AppDependencies,
  task: Task,
  id: TaskId,
  issueId: IssueId | undefined,
  background: boolean
): PersistReadyOutcome {
  const priorActiveTaskId = deps.workspace.activeTaskId
  const requestedIssue = issueId ? deps.workspace.issue(issueId) : undefined
  const issueRollback = requestedIssue
    ? {
        issueId: requestedIssue.id,
        priorTaskId: requestedIssue.taskId,
        priorStatus: requestedIssue.status
      }
    : undefined

  let bindOutcome: BindOutcome = {}
  try {
    deps.persistence.transaction(() => {
      deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
      // Background (octopus-cli control socket): leave the user's active task alone.
      if (!background) {
        deps.workspace.setActiveTask(id)
        deps.persistence.setActiveTask(id)
      }
      bindOutcome = bindRequestedIssue(deps, issueId, id)
    })
  } catch (err) {
    deps.workspace.removeTask(id)
    if (!background) deps.workspace.setActiveTask(priorActiveTaskId)
    if (issueRollback) {
      deps.workspace.restoreIssueBinding(
        issueRollback.issueId,
        issueRollback.priorTaskId,
        issueRollback.priorStatus
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
  return { ok: true, bindOutcome }
}

export async function createTask(
  deps: AppDependencies,
  input: CreateTaskInput
): Promise<CommandResult> {
  const id = deps.ids.newTaskId()
  const now = deps.clock.now()
  const position = deps.workspace.tasks().length

  const task = Task.create({ id, name: input.name, position, createdAt: now })

  // "No Repo" task (§5.4): nothing to provision. Drive it straight to Ready
  // (repo-less), persist, and make it active — synchronously, so there is no
  // script, no `scriptProgress`, and no provisioning failure path (only the
  // persist failure path below applies). The modal closes on the
  // `activeTaskChanged` event just like the provisioning modes.
  if (input.mode === 'none') {
    task.markProvisioning()
    task.markReadyNoRepo()
    deps.workspace.addTask(task)

    const result = persistReadyTask(deps, task, id, input.issueId, input.background === true)
    if (!result.ok) {
      // Nothing was ever announced for this task (no `taskCreated` yet in this
      // mode), so there is no stuck spinner to undo — just report the failure.
      return { ok: false, error: result.error }
    }

    deps.bus.publish({
      type: 'taskCreated',
      task: task.toSnapshot(deps.aggregator),
      ...(input.background ? { background: true } : {})
    })
    announceBindOutcome(deps, id, result.bindOutcome)
    if (!input.background) deps.bus.publish({ type: 'activeTaskChanged', taskId: id })
    return { ok: true, taskId: id }
  }

  task.markProvisioning()
  deps.workspace.addTask(task)
  // Announce the provisioning task so the UI shows a spinner while the script runs.
  deps.bus.publish({
    type: 'taskCreated',
    task: task.toSnapshot(deps.aggregator),
    ...(input.background ? { background: true } : {})
  })

  let worktree: WorktreeRef
  try {
    // Either provision a brand-new worktree or adopt an existing directory; both
    // yield a validated `WorktreeRef` and rejoin the shared markReady tail below.
    worktree =
      input.mode === 'new'
        ? await provisionNew(deps, id, input)
        : await adoptExisting(deps, id, input)
  } catch (err) {
    task.markProvisionFailed()
    const message = err instanceof Error ? err.message : String(err)
    // Rollback is best-effort and path-dependent: the provider rejects WITHOUT
    // returning a validated path (script/git non-zero exit, timeout, or failed
    // validation), so Octopus has no worktree path to remove (§6.4). The failed
    // task therefore stays in `ProvisionFailed` — unpersisted — for the UI to
    // Retry or force-forget (§3.5). Cleanup of any partial on-disk worktree is the
    // script's / git's own concern.
    deps.bus.publish({
      type: 'scriptError',
      taskId: id,
      script: input.mode === 'new' ? 'create_worktree' : 'adopt',
      exitCode: null,
      stderr: message,
      ...(input.background ? { background: true } : {})
    })
    return { ok: false, error: message }
  }

  task.markReady(worktree)

  // Persist the now-Ready task, bind the requested issue (if any), and make it
  // active, atomically (§6.6, §13.3).
  const result = persistReadyTask(deps, task, id, input.issueId, input.background === true)
  if (!result.ok) {
    // A PERSIST failure, distinct from the provisioning `catch` above: the task
    // already left `Provisioning` for `Ready`, so `markProvisionFailed` would be
    // an illegal transition (and would mask this real error). The task is gone
    // from the workspace (see `persistReadyTask`); undo the `taskCreated`
    // (Provisioning) the UI already received instead of leaving its spinner
    // stuck, and surface the real error as a toast too.
    deps.bus.publish({ type: 'taskDeleted', taskId: id })
    deps.bus.publish({
      type: 'error',
      taskId: id,
      message: result.error,
      ...(input.background ? { background: true } : {})
    })
    return { ok: false, error: result.error }
  }

  deps.bus.publish({
    type: 'taskCreated',
    task: task.toSnapshot(deps.aggregator),
    ...(input.background ? { background: true } : {})
  })
  announceBindOutcome(deps, id, result.bindOutcome)
  if (!input.background) deps.bus.publish({ type: 'activeTaskChanged', taskId: id })
  return { ok: true, taskId: id }
}

/** Provision a brand-new worktree (repo-local script or native git, §6.4). */
async function provisionNew(
  deps: AppDependencies,
  id: TaskId,
  input: CreateTaskFromNewInput
): Promise<WorktreeRef> {
  const result = await deps.worktrees.create(
    {
      taskId: id,
      taskName: input.name,
      repoDir: input.repoDir,
      sourceBranch: input.sourceBranch,
      newBranch: input.newBranch
    },
    (line) =>
      deps.bus.publish({
        type: 'scriptProgress',
        taskId: id,
        line,
        ...(input.background ? { background: true } : {})
      })
  )

  return WorktreeRef.create({
    path: result.path,
    branch: input.newBranch,
    baseRef: input.sourceBranch,
    // Octopus provisioned this worktree, so it is removed when the task is deleted (§6.4).
    managed: true,
    provisionedBy: {
      script: result.script,
      args: result.args,
      repoRoot: input.repoDir,
      provisionedAt: deps.clock.now()
    }
  })
}

/**
 * Adopt an existing worktree directory. The provider detects the owning repo root
 * (stored as `repoRoot` so a later delete is safe, §6.4) and current branch;
 * `baseRef` is unknown for an adopted worktree.
 */
async function adoptExisting(
  deps: AppDependencies,
  id: TaskId,
  input: CreateTaskFromExistingInput
): Promise<WorktreeRef> {
  const result = await deps.worktrees.adopt({
    taskId: id,
    taskName: input.name,
    worktreeDir: input.worktreeDir
  })

  return WorktreeRef.create({
    path: result.path,
    branch: result.branch,
    baseRef: undefined,
    // Adopted from an existing repo/checkout: deleting the task leaves it on disk (§6.4).
    managed: false,
    provisionedBy: {
      script: 'adopt',
      args: [],
      repoRoot: result.repoRoot,
      provisionedAt: deps.clock.now()
    }
  })
}
