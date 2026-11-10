/**
 * "Issues" (I19, DESIGN "Issues" §13.3) end to end, over a REAL `CommandLoop`
 * wired on the `test-fakes.ts` fakes via `makeDeps()`. Every mutation goes
 * through `loop.dispatch(...)` (never a use case directly) so the whole
 * command-kind-routing + `DomainError`-catching path in `CommandLoop` is
 * exercised, exactly like the production IPC path would drive it.
 *
 * Covers: createTask binding a requested issue on reaching Ready, the
 * deleteTask dirty-confirm gate plus "delete both" (`alsoDeleteIssue`),
 * removeProject's issue-cleanup side effect, bindIssue's "already linked"
 * rejection and rebind-frees-the-old-task behavior, the todo→in_progress
 * automation (and that it never fires for a non-Todo issue), deleting an
 * unbound issue, and that a bound + an unbound issue both survive a simulated
 * app restart (`Workspace.hydrate` fed a fresh snapshot).
 */

import { describe, it, expect } from 'vitest'
import { CommandLoop } from '../../src/application/command-loop'
import { makeDeps, taskInput, type FakeDeps } from '../../src/application/use-cases/test-fakes'
import { Workspace } from '../../src/domain/workspace'
import { IssueStatus } from '../../src/domain/issue'
import { TaskLifecycle } from '../../src/domain/lifecycle'
import type { WorkspaceSnapshot } from '../../src/domain/snapshots'

/** A fresh rig: a real `CommandLoop` over a fresh set of fakes. */
function rig(): { loop: CommandLoop; fd: FakeDeps } {
  const fd = makeDeps()
  return { loop: new CommandLoop(fd.deps), fd }
}

describe('Issues end to end over the real CommandLoop (I19, "Issues" §13.3)', () => {
  it('createTask binds a requested issue once the task reaches Ready, moving it Todo → InProgress', async () => {
    const { loop, fd } = rig()

    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Fix the thing', description: 'desc' }
    })
    expect(created.ok).toBe(true)
    const issueId = created.issueId!

    const result = await loop.dispatch({
      kind: 'createTask',
      input: taskInput('alpha', { issueId })
    })
    expect(result.ok).toBe(true)

    const task = fd.workspace.tasks().find((t) => t.name === 'alpha')!
    expect(task.lifecycle).toBe(TaskLifecycle.Ready)

    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(task.id)
    expect(issue.status).toBe(IssueStatus.InProgress)
  })

  it('deleteTask: dirty gate blocks until confirmed, then "delete both" removes the task AND the issue', async () => {
    const { loop, fd } = rig()

    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Bound issue', description: 'desc' }
    })
    const issueId = created.issueId!
    await loop.dispatch({ kind: 'createTask', input: taskInput('beta', { issueId }) })
    const task = fd.workspace.tasks().find((t) => t.name === 'beta')!
    const taskId = task.id

    // Dirty gate: without `confirmedDirty`, deletion is refused and NOTHING is
    // torn down — the task and its bound issue are both still fully intact.
    fd.worktrees.dirty = true
    const blocked = await loop.dispatch({ kind: 'deleteTask', input: { taskId } })
    expect(blocked).toEqual({ ok: false, needsDirtyConfirm: true })
    expect(fd.workspace.task(taskId)).toBeDefined()
    expect(fd.workspace.task(taskId)!.lifecycle).toBe(TaskLifecycle.Ready)
    expect(fd.workspace.issue(issueId)!.taskId).toBe(taskId)

    // Confirmed + "delete both": the task AND the issue are gone, everywhere.
    const confirmed = await loop.dispatch({
      kind: 'deleteTask',
      input: { taskId, confirmedDirty: true, alsoDeleteIssue: true }
    })
    expect(confirmed).toEqual({ ok: true })

    expect(fd.workspace.task(taskId)).toBeUndefined()
    expect(fd.workspace.issue(issueId)).toBeUndefined()
    expect(fd.persistence.deletedTasks).toContain(taskId)
    expect(fd.persistence.deletedIssues).toContain(issueId)
    expect(fd.persistence.issues.has(issueId)).toBe(false)

    expect(fd.bus.ofType('taskDeleted').some((e) => e.taskId === taskId)).toBe(true)
    expect(fd.bus.ofType('issueDeleted').some((e) => e.issueId === issueId)).toBe(true)
  })

  it('removeProject clears projectPath off every issue configured against it', async () => {
    const { loop, fd } = rig()

    const added = await loop.dispatch({ kind: 'addProject', input: { dir: '/proj' } })
    expect(added.ok).toBe(true)
    const projectPath = added.project!.path

    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Project-scoped', description: 'desc', projectPath }
    })
    expect(created.ok).toBe(true)
    const issueId = created.issueId!
    expect(fd.workspace.issue(issueId)!.projectPath).toBe(projectPath)
    expect(fd.workspace.issue(issueId)!.taskId).toBeUndefined()

    const removed = await loop.dispatch({ kind: 'removeProject', input: { path: projectPath } })
    expect(removed).toEqual({ ok: true })

    expect(fd.workspace.issue(issueId)!.projectPath).toBeUndefined()
    // The clear reached the DB as well, not just the in-memory `Workspace`.
    expect(fd.persistence.issues.get(issueId)?.projectPath).toBeUndefined()
    expect(
      fd.bus
        .ofType('issueUpserted')
        .some((e) => e.issue.id === issueId && e.issue.projectPath === undefined)
    ).toBe(true)
    expect(fd.settings.load().projects ?? []).toEqual([])
  })

  it('bindIssue rejects a task already linked to a different issue, leaving the existing bind untouched', async () => {
    const { loop, fd } = rig()

    const issueA = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'A', description: 'd' } })
    ).issueId!
    const issueB = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'B', description: 'd' } })
    ).issueId!
    await loop.dispatch({ kind: 'createTask', input: taskInput('task-x') })
    const taskId = fd.workspace.tasks().find((t) => t.name === 'task-x')!.id

    const boundA = await loop.dispatch({ kind: 'bindIssue', input: { issueId: issueA, taskId } })
    expect(boundA).toEqual({ ok: true })

    const boundB = await loop.dispatch({ kind: 'bindIssue', input: { issueId: issueB, taskId } })
    expect(boundB).toEqual({ ok: false, error: 'already linked' })

    expect(fd.workspace.issue(issueA)!.taskId).toBe(taskId)
    expect(fd.workspace.issue(issueB)!.taskId).toBeUndefined()
  })

  it('binding a non-Todo issue leaves its status unchanged (the Todo → InProgress automation only fires from Todo)', async () => {
    const { loop, fd } = rig()

    const issueId = (
      await loop.dispatch({
        kind: 'createIssue',
        input: { name: 'In review already', description: 'd' }
      })
    ).issueId!
    const toReview = await loop.dispatch({
      kind: 'updateIssue',
      input: { issueId, status: IssueStatus.InReview }
    })
    expect(toReview.ok).toBe(true)

    await loop.dispatch({ kind: 'createTask', input: taskInput('task-y') })
    const taskId = fd.workspace.tasks().find((t) => t.name === 'task-y')!.id

    const bound = await loop.dispatch({ kind: 'bindIssue', input: { issueId, taskId } })
    expect(bound).toEqual({ ok: true })

    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(taskId)
    expect(issue.status).toBe(IssueStatus.InReview)
  })

  it('rebinding an issue to a different task frees its old task for another issue', async () => {
    const { loop, fd } = rig()

    const issueA = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'A', description: 'd' } })
    ).issueId!
    const issueC = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'C', description: 'd' } })
    ).issueId!
    await loop.dispatch({ kind: 'createTask', input: taskInput('task-1') })
    await loop.dispatch({ kind: 'createTask', input: taskInput('task-2') })
    const task1 = fd.workspace.tasks().find((t) => t.name === 'task-1')!.id
    const task2 = fd.workspace.tasks().find((t) => t.name === 'task-2')!.id

    await loop.dispatch({ kind: 'bindIssue', input: { issueId: issueA, taskId: task1 } })
    expect(fd.workspace.issue(issueA)!.taskId).toBe(task1)

    // Rebind A onto a DIFFERENT Ready task: task1 is now free.
    const rebind = await loop.dispatch({
      kind: 'bindIssue',
      input: { issueId: issueA, taskId: task2 }
    })
    expect(rebind).toEqual({ ok: true })
    expect(fd.workspace.issue(issueA)!.taskId).toBe(task2)

    // Proof task1 is free: binding a different issue to it succeeds, not "already linked".
    const bindC = await loop.dispatch({
      kind: 'bindIssue',
      input: { issueId: issueC, taskId: task1 }
    })
    expect(bindC).toEqual({ ok: true })
    expect(fd.workspace.issue(issueC)!.taskId).toBe(task1)
  })

  it('m4: a bindIssue and a createTask({issueId}) dispatched back-to-back (no await) still serialize through the FIFO', async () => {
    const { loop, fd } = rig()

    await loop.dispatch({ kind: 'createTask', input: taskInput('task-A') })
    const taskA = fd.workspace.tasks().find((t) => t.name === 'task-A')!.id
    const issueId = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'Contested', description: 'd' } })
    ).issueId!

    // Dispatched WITHOUT awaiting between them: `CommandLoop.dispatch` chains
    // each call onto `this.tail` synchronously (before either body runs), so
    // the FIFO still guarantees bindIssue completes — binding the issue to
    // taskA — before createTask's `bindRequestedIssue` ever reads it.
    const bindPromise = loop.dispatch({ kind: 'bindIssue', input: { issueId, taskId: taskA } })
    const createPromise = loop.dispatch({
      kind: 'createTask',
      input: taskInput('task-B', { issueId })
    })

    const [bindResult, createResult] = await Promise.all([bindPromise, createPromise])

    expect(bindResult).toEqual({ ok: true })
    expect(createResult).toEqual({ ok: true, taskId: expect.any(String) })

    // The new task exists but was NOT bound — by the time it ran, the issue was
    // already (stale-view) bound to taskA (create-task.ts's module doc).
    const taskB = fd.workspace.tasks().find((t) => t.name === 'task-B')!
    expect(fd.workspace.issueForTask(taskB.id)).toBeUndefined()

    // The issue stays on taskA, the one bindIssue actually bound it to.
    expect(fd.workspace.issue(issueId)!.taskId).toBe(taskA)

    // Exactly one stale-view error toast, from createTask's attempt.
    const errors = fd.bus.ofType('error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('Issue was linked to another task; task created without it')
    expect(errors[0].taskId).toBe(taskB.id)
  })

  it('deleteIssue on an unbound issue succeeds cleanly with no task side effects', async () => {
    const { loop, fd } = rig()

    await loop.dispatch({ kind: 'createTask', input: taskInput('unaffected') })
    const taskId = fd.workspace.tasks().find((t) => t.name === 'unaffected')!.id

    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Unbound', description: 'd' }
    })
    const issueId = created.issueId!
    expect(fd.workspace.issue(issueId)!.taskId).toBeUndefined()

    const deleted = await loop.dispatch({ kind: 'deleteIssue', input: { issueId } })
    expect(deleted).toEqual({ ok: true })

    expect(fd.workspace.issue(issueId)).toBeUndefined()
    expect(fd.persistence.deletedIssues).toContain(issueId)
    expect(fd.bus.ofType('issueDeleted').some((e) => e.issueId === issueId)).toBe(true)

    // The unrelated task was never touched.
    const task = fd.workspace.task(taskId)!
    expect(task.lifecycle).toBe(TaskLifecycle.Ready)
  })

  it('survives a simulated restart: a bound issue stays bound, an unbound issue stays unbound', async () => {
    const { loop, fd } = rig()

    const boundIssueId = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'Bound', description: 'd' } })
    ).issueId!
    await loop.dispatch({
      kind: 'createTask',
      input: taskInput('restart-task', { issueId: boundIssueId })
    })
    const taskId = fd.workspace.tasks().find((t) => t.name === 'restart-task')!.id
    expect(fd.workspace.issue(boundIssueId)!.taskId).toBe(taskId)

    const unboundIssueId = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'Unbound', description: 'd' } })
    ).issueId!

    // The snapshot the fakes would persist across a restart: `FakePersistence`
    // tracks the `issues` table faithfully (`load()` merges its `issues` map),
    // but — unlike the real SQLite store — never records `upsertTask` calls
    // into anything `load()` returns (`upsertTask` only pushes to the
    // assertion-only `upsertedTasks` array). So the task side of "what's on
    // disk" is read from `Workspace.toSnapshot` (what a real `upsertTask` call
    // was actually given) instead, mirroring exactly what the real persistence
    // adapter would have written.
    const persisted = fd.persistence.load()
    const snapshot: WorkspaceSnapshot = {
      tasks: fd.workspace.toSnapshot(fd.deps.aggregator).tasks,
      activeTaskId: fd.workspace.activeTaskId,
      issues: persisted.issues
    }

    // m10: this is the actual "restart" simulation — a fresh `Workspace` rebuilt
    // from scratch via `hydrate(toSnapshot())`-shaped data (the task side taken
    // from `Workspace.toSnapshot`, the issue side from what `FakePersistence`
    // actually recorded), exactly like a real app restart reloads from disk.
    const restored = Workspace.hydrate(snapshot, { defaultSessionTypeId: 'terminal' })

    const boundAfter = restored.issue(boundIssueId)!
    expect(boundAfter.taskId).toBe(taskId)
    expect(boundAfter.status).toBe(IssueStatus.InProgress)

    const unboundAfter = restored.issue(unboundIssueId)!
    expect(unboundAfter.taskId).toBeUndefined()

    const taskAfter = restored.task(taskId)!
    expect(taskAfter.id).toBe(taskId)
    expect(taskAfter.name).toBe(fd.workspace.task(taskId)!.name)
    expect(taskAfter.position).toBe(fd.workspace.task(taskId)!.position)
  })
  it('Blocked + reasons round-trip through the loop, survive a status change, and a restart', async () => {
    const { loop, fd } = rig()
    const issueId = (
      await loop.dispatch({ kind: 'createIssue', input: { name: 'Stuck', description: 'd' } })
    ).issueId!

    const blocked = await loop.dispatch({
      kind: 'updateIssue',
      input: { issueId, status: IssueStatus.Blocked, blockedReasons: 'waiting on **infra**' }
    })
    expect(blocked.ok).toBe(true)
    expect(fd.workspace.issue(issueId)).toMatchObject({
      status: IssueStatus.Blocked,
      blockedReasons: 'waiting on **infra**'
    })

    // A status-only change away from Blocked keeps the reasons.
    await loop.dispatch({
      kind: 'updateIssue',
      input: { issueId, status: IssueStatus.InProgress }
    })
    expect(fd.persistence.issues.get(issueId)).toMatchObject({
      status: IssueStatus.InProgress,
      blockedReasons: 'waiting on **infra**'
    })

    await loop.dispatch({ kind: 'updateIssue', input: { issueId, status: IssueStatus.Blocked } })

    // Restart: a fresh Workspace hydrated from what persistence recorded.
    const restored = Workspace.hydrate(
      { tasks: [], activeTaskId: undefined, issues: fd.persistence.load().issues },
      { defaultSessionTypeId: 'terminal' }
    )
    expect(restored.issue(issueId)).toMatchObject({
      status: IssueStatus.Blocked,
      blockedReasons: 'waiting on **infra**'
    })
  })
})
