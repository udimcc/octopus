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
 *   4. On failure: `markProvisionFailed`, best-effort rollback via the delete
 *      script, emit `scriptError`. The task record is kept in `ProvisionFailed`
 *      so the UI can offer Retry / force-forget (§3.5) — it is NOT persisted
 *      (only `Ready` tasks reach the DB, matching `taskToRow`'s worktree guard).
 *
 * The whole thing runs inside the single-writer loop, so no other mutation
 * interleaves while the (slow) script runs — the workspace is consistent
 * throughout (§6.6).
 */

import type { AppDependencies } from '../dependencies'
import type {
  CreateTaskInput,
  CreateTaskFromNewInput,
  CreateTaskFromExistingInput
} from '../commands'
import type { TaskId } from '../../domain/ids'
import { Task } from '../../domain/task'
import { WorktreeRef } from '../../domain/worktree-ref'

export async function createTask(deps: AppDependencies, input: CreateTaskInput): Promise<void> {
  const id = deps.ids.newTaskId()
  const now = deps.clock.now()
  const position = deps.workspace.tasks().length

  const task = Task.create({ id, name: input.name, position, createdAt: now })
  task.markProvisioning()
  deps.workspace.addTask(task)
  // Announce the provisioning task so the UI shows a spinner while the script runs.
  deps.bus.publish({ type: 'taskCreated', task: task.toSnapshot(deps.aggregator) })

  try {
    // Either provision a brand-new worktree or adopt an existing directory; both
    // yield a validated `WorktreeRef` and rejoin the shared markReady tail below.
    const worktree =
      input.mode === 'new'
        ? await provisionNew(deps, id, input)
        : await adoptExisting(deps, id, input)
    task.markReady(worktree)

    // Persist the now-Ready task and make it active, atomically (§6.6).
    deps.persistence.transaction(() => {
      deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
      deps.workspace.setActiveTask(id)
      deps.persistence.setActiveTask(id)
    })

    deps.bus.publish({ type: 'taskCreated', task: task.toSnapshot(deps.aggregator) })
    deps.bus.publish({ type: 'activeTaskChanged', taskId: id })
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
      stderr: message
    })
  }
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
    (line) => deps.bus.publish({ type: 'scriptProgress', taskId: id, line })
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
