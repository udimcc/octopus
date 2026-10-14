import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { deleteTask } from './delete-task'
import { createIssue } from './create-issue'
import { bindIssue } from './bind-issue'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId } from '../../domain/ids'
import { TaskLifecycle } from '../../domain/lifecycle'
import { IssueStatus } from '../../domain/issue'

/** Seed one Ready, active task ('task-1') with `sessionCount` running sessions. */
async function seedReadyTask(
  sessionCount = 0
): Promise<FakeDeps & { taskId: ReturnType<typeof asTaskId> }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  for (let i = 0; i < sessionCount; i++) {
    await openSession(fd.deps, { taskId })
  }
  return { ...fd, taskId }
}

describe('deleteTask dirty gate (§6.6 step 2, §6.4)', () => {
  it('returns needsDirtyConfirm and tears down NOTHING when the worktree is dirty', async () => {
    const fd = await seedReadyTask(1)
    fd.worktrees.dirty = true
    const runtime = fd.sessions.last()!

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result).toEqual({ ok: false, needsDirtyConfirm: true })
    // Task still present and Ready; runtime untouched; nothing removed.
    expect(fd.workspace.task(fd.taskId)?.lifecycle).toBe(TaskLifecycle.Ready)
    expect(runtime.stopped).toBe(false)
    expect(fd.worktrees.removeCalls).toEqual([])
    expect(fd.persistence.deletedTasks).toEqual([])
  })

  it('proceeds when the user confirms the dirty worktree', async () => {
    const fd = await seedReadyTask(1)
    fd.worktrees.dirty = true

    const result = await deleteTask(fd.deps, { taskId: fd.taskId, confirmedDirty: true })

    expect(result).toEqual({ ok: true })
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    expect(fd.worktrees.removeCalls).toHaveLength(1)
  })
})

describe('deleteTask strict teardown order (I3, §6.6)', () => {
  it('stops+disposes runtimes, runs the delete script, removes rows, and clears the active pointer', async () => {
    const fd = await seedReadyTask(2)
    const [rt1, rt2] = fd.sessions.created

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result).toEqual({ ok: true })
    // Every runtime stopped + disposed + dropped from the registry.
    expect(rt1.stopped && rt1.disposed).toBe(true)
    expect(rt2.stopped && rt2.disposed).toBe(true)
    expect(fd.deps.runtimes.all()).toEqual([])

    // Delete ran with the stored path AND the task's OWN repoDir (round-tripped
    // from the create input via provisionedBy.repoRoot, §6.4 — not a global).
    expect(fd.worktrees.removeCalls).toHaveLength(1)
    expect(fd.worktrees.removeCalls[0]).toMatchObject({
      taskName: 'T',
      path: '/wt/task',
      repoDir: '/repo'
    })

    // Row removed in a transaction; task gone; active pointer cleared (it was active).
    expect(fd.persistence.deletedTasks).toEqual([fd.taskId])
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    expect(fd.workspace.activeTaskId).toBeUndefined()

    // Announced taskDeleted (+ activeTaskChanged since it was active).
    expect(fd.bus.ofType('taskDeleted').map((e) => e.taskId)).toEqual([fd.taskId])
    expect(fd.bus.ofType('activeTaskChanged')).toHaveLength(2) // create + delete
  })
})

describe('deleteTask on an adopted repo (§6.4)', () => {
  it('leaves the directory on disk (managed:false) but still removes the task', async () => {
    const fd = makeDeps()
    fd.worktrees.adoptedPath = '/home/u/worktrees/wt-x'
    fd.worktrees.adoptedRepoRoot = '/home/u/project'
    await createTask(fd.deps, {
      mode: 'existing',
      name: 'Adopted',
      worktreeDir: '/home/u/worktrees/wt-x'
    })
    const taskId = asTaskId('task-1')

    const result = await deleteTask(fd.deps, { taskId })

    expect(result).toEqual({ ok: true })
    // "From Existing Repo" tasks are `managed:false` — Octopus did not provision the
    // directory, so it is NOT removed from disk (§6.4). No worktree script runs.
    expect(fd.worktrees.removeCalls).toEqual([])
    // The task record + workspace entry are still torn down and announced.
    expect(fd.workspace.task(taskId)).toBeUndefined()
    expect(fd.persistence.deletedTasks).toEqual([taskId])
    expect(fd.bus.ofType('taskDeleted').map((e) => e.taskId)).toEqual([taskId])
  })
})

describe('deleteTask remove-script failure (I4)', () => {
  it('keeps the record as DeleteFailed, emits scriptError, and returns ok:false', async () => {
    const fd = await seedReadyTask(1)
    fd.worktrees.removeRejectsWith = new Error('delete.sh: permission denied')
    const runtime = fd.sessions.last()!

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/permission denied/)
    // Runtime WAS torn down (step 3 precedes the failing script), but the record stays.
    expect(runtime.disposed).toBe(true)
    const task = fd.workspace.task(fd.taskId)
    expect(task?.lifecycle).toBe(TaskLifecycle.DeleteFailed)
    // No row deletion happened (we stopped at the failed script).
    expect(fd.persistence.deletedTasks).toEqual([])
    expect(fd.bus.ofType('scriptError')).toHaveLength(1)
  })
})

describe('deleteTask force-forget (I4)', () => {
  it('removes a DeleteFailed task without re-running the delete script when forced', async () => {
    const fd = await seedReadyTask(0)
    // First attempt fails → task is DeleteFailed.
    fd.worktrees.removeRejectsWith = new Error('boom')
    await deleteTask(fd.deps, { taskId: fd.taskId })
    expect(fd.workspace.task(fd.taskId)?.lifecycle).toBe(TaskLifecycle.DeleteFailed)
    const removeCallsBefore = fd.worktrees.removeCalls.length

    // Force-forget: no further script run, record dropped.
    const result = await deleteTask(fd.deps, { taskId: fd.taskId, force: true })
    expect(result).toEqual({ ok: true })
    expect(fd.worktrees.removeCalls.length).toBe(removeCallsBefore) // no new script call
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    expect(fd.persistence.deletedTasks).toContain(fd.taskId)
  })

  it('force-forget skips the dirty gate entirely', async () => {
    const fd = await seedReadyTask(0)
    fd.worktrees.dirty = true
    const result = await deleteTask(fd.deps, { taskId: fd.taskId, force: true })
    // No needsDirtyConfirm despite a dirty tree — force bypasses the gate.
    expect(result).toEqual({ ok: true })
  })
})

describe('deleteTask idempotence (I4)', () => {
  it('deleting an already-gone task is a success no-op', async () => {
    const { deps } = makeDeps()
    const result = await deleteTask(deps, { taskId: asTaskId('ghost') })
    expect(result).toEqual({ ok: true })
  })
})

describe('deleteTask issue unbind/delete (Issues §13.3, I19)', () => {
  it('alsoDeleteIssue: true deletes the bound issue ONLY when the task delete actually succeeds', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: fd.taskId })

    const result = await deleteTask(fd.deps, { taskId: fd.taskId, alsoDeleteIssue: true })

    expect(result).toEqual({ ok: true })
    expect(fd.persistence.deletedIssues).toEqual([issueId])
    expect(fd.workspace.issue(issueId)).toBeUndefined()
    expect(fd.bus.ofType('issueDeleted').map((e) => e.issueId)).toEqual([issueId])
  })

  it('I1b: a step-5 persist failure (deleteIssue throws) rejects and leaves the task + issue binding intact', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: fd.taskId })
    fd.persistence.deleteIssue = () => {
      throw new Error('disk full')
    }

    // delete-task.ts has no try/catch around the step-5 transaction (unlike
    // create-task.ts's persistReadyTask), so a throw inside it propagates out of
    // the use-case instead of surfacing as `{ ok: false }`.
    await expect(deleteTask(fd.deps, { taskId: fd.taskId, alsoDeleteIssue: true })).rejects.toThrow(
      'disk full'
    )

    // workspace.removeTask/removeIssue (delete-task.ts:156-166) run only AFTER
    // the transaction call returns, so the throw never reaches them: the task
    // and the issue (still bound, still InProgress) are both still there.
    expect(fd.workspace.task(fd.taskId)).toBeDefined()
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(fd.taskId)
    expect(issue.status).toBe(IssueStatus.InProgress)
    expect(fd.bus.ofType('taskDeleted')).toEqual([])
    expect(fd.bus.ofType('issueDeleted')).toEqual([])
    // Only createIssue's + bindIssue's own issueUpserted events — none from the
    // failed delete attempt.
    expect(fd.bus.ofType('issueUpserted').filter((e) => e.issue.id === issueId)).toHaveLength(2)
  })

  it('a needsDirtyConfirm return leaves the bound issue COMPLETELY untouched', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: fd.taskId })
    fd.worktrees.dirty = true

    const result = await deleteTask(fd.deps, { taskId: fd.taskId, alsoDeleteIssue: true })

    expect(result).toEqual({ ok: false, needsDirtyConfirm: true })
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(fd.taskId)
    expect(issue.status).toBe(IssueStatus.InProgress)
    expect(fd.persistence.deletedIssues).toEqual([])
    expect(fd.bus.ofType('issueDeleted')).toEqual([])
    // Only the earlier createIssue + bindIssue upserts — nothing new from the delete attempt.
    expect(fd.bus.ofType('issueUpserted').filter((e) => e.issue.id === issueId)).toHaveLength(2)
  })

  it('a worktree-remove failure also leaves the bound issue untouched (task stays DeleteFailed)', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: fd.taskId })
    fd.worktrees.removeRejectsWith = new Error('permission denied')

    const result = await deleteTask(fd.deps, { taskId: fd.taskId, alsoDeleteIssue: true })

    expect(result.ok).toBe(false)
    expect(fd.workspace.task(fd.taskId)?.lifecycle).toBe(TaskLifecycle.DeleteFailed)
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(fd.taskId)
    expect(issue.status).toBe(IssueStatus.InProgress)
    expect(fd.persistence.deletedIssues).toEqual([])
  })

  it('a plain delete (no alsoDeleteIssue) unbinds the issue without changing its status', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: fd.taskId })

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result).toEqual({ ok: true })
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBeUndefined()
    expect(issue.status).toBe(IssueStatus.InProgress)
    // MINOR 4: `fd.persistence.issues.get(issueId)?.taskId` is vacuous here —
    // `FakePersistence.deleteTask` mirrors the real `ON DELETE SET NULL` and would
    // leave the map's `taskId` undefined even if delete-task.ts's own explicit
    // `upsertIssue(unboundIssueSnapshot)` call were deleted. Assert the recorded
    // upsert call itself instead, which only happens if that call runs.
    const upserted = fd.persistence.upsertedIssues.at(-1)
    expect(upserted).toMatchObject({ id: issueId, status: IssueStatus.InProgress })
    expect(upserted?.taskId).toBeUndefined()
    expect(fd.bus.ofType('issueUpserted').at(-1)?.issue.taskId).toBeUndefined()
  })

  it('the force-forget path still processes the bound issue the same as a normal delete', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: fd.taskId })
    // First attempt fails → DeleteFailed, bound issue still untouched.
    fd.worktrees.removeRejectsWith = new Error('boom')
    await deleteTask(fd.deps, { taskId: fd.taskId })
    expect(fd.workspace.task(fd.taskId)?.lifecycle).toBe(TaskLifecycle.DeleteFailed)

    const result = await deleteTask(fd.deps, {
      taskId: fd.taskId,
      force: true,
      alsoDeleteIssue: true
    })

    expect(result).toEqual({ ok: true })
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    expect(fd.workspace.issue(issueId)).toBeUndefined()
    expect(fd.persistence.deletedIssues).toEqual([issueId])
    expect(fd.bus.ofType('issueDeleted').map((e) => e.issueId)).toEqual([issueId])
  })

  it('m11: alsoDeleteIssue on a task with NO bound issue is a harmless no-op (no issue* events from the delete)', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, {
      name: 'Unrelated, never bound',
      description: ''
    }).issueId!
    const issueUpsertedBefore = fd.bus.ofType('issueUpserted').length

    const result = await deleteTask(fd.deps, { taskId: fd.taskId, alsoDeleteIssue: true })

    expect(result).toEqual({ ok: true })
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    // The unrelated issue was never touched: still there, still unbound.
    expect(fd.workspace.issue(issueId)).toBeDefined()
    expect(fd.workspace.issue(issueId)!.taskId).toBeUndefined()
    expect(fd.persistence.deletedIssues).toEqual([])
    expect(fd.bus.ofType('issueDeleted')).toEqual([])
    // Only createIssue's own upsert — nothing new published by this delete.
    expect(fd.bus.ofType('issueUpserted')).toHaveLength(issueUpsertedBefore)
  })

  it('the dirty-confirm CANCEL path (never confirming) keeps BOTH the task and the issue fully intact', async () => {
    const fd = await seedReadyTask(0)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: fd.taskId })
    fd.worktrees.dirty = true

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result).toEqual({ ok: false, needsDirtyConfirm: true })
    // The user cancels: no second dispatch with confirmedDirty ever happens.
    expect(fd.workspace.task(fd.taskId)?.lifecycle).toBe(TaskLifecycle.Ready)
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(fd.taskId)
    expect(issue.status).toBe(IssueStatus.InProgress)
    expect(fd.persistence.deletedTasks).toEqual([])
    expect(fd.persistence.deletedIssues).toEqual([])
  })
})
