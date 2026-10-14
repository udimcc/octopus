import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { createIssue } from './create-issue'
import { bindIssue } from './bind-issue'
import { makeDeps, taskInput } from './test-fakes'
import { IssueStatus } from '../../domain/issue'
import { TaskLifecycle } from '../../domain/lifecycle'
import { asIssueId, asTaskId } from '../../domain/ids'

describe('bindIssue ("Issues" §13.3, I19)', () => {
  it('binds a free, Ready task to a Todo issue: flips to InProgress, persists, publishes', async () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })
    const id = issueId!

    const result = bindIssue(deps, { issueId: id, taskId: task.id })

    expect(result).toEqual({ ok: true })
    const issue = workspace.issue(id)!
    expect(issue.taskId).toBe(task.id)
    expect(issue.status).toBe(IssueStatus.InProgress)
    expect(persistence.upsertedIssues[persistence.upsertedIssues.length - 1]).toMatchObject({
      id,
      taskId: task.id,
      status: IssueStatus.InProgress
    })
    // m1: the published event itself carries the new binding/status, not just
    // "something" having been published.
    expect(bus.ofType('issueUpserted').at(-1)?.issue).toMatchObject({
      id,
      taskId: task.id,
      status: IssueStatus.InProgress
    })
  })

  it('rejects binding a task already linked to a DIFFERENT issue, leaving both unchanged', async () => {
    const { deps, workspace } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const issue1 = createIssue(deps, { name: 'Issue 1', description: '' }).issueId!
    const issue2 = createIssue(deps, { name: 'Issue 2', description: '' }).issueId!
    bindIssue(deps, { issueId: issue1, taskId: task.id })

    const result = bindIssue(deps, { issueId: issue2, taskId: task.id })

    expect(result).toEqual({ ok: false, error: 'already linked' })
    expect(workspace.issue(issue1)!.taskId).toBe(task.id)
    expect(workspace.issue(issue1)!.status).toBe(IssueStatus.InProgress)
    expect(workspace.issue(issue2)!.taskId).toBeUndefined()
    expect(workspace.issue(issue2)!.status).toBe(IssueStatus.Todo)
  })

  it('rejects binding to a task not yet persisted (e.g. ProvisionFailed — no tasks row for the FK)', async () => {
    const { deps, workspace, worktrees } = makeDeps()
    worktrees.createRejectsWith = new Error('create.sh exited 1')
    await createTask(deps, taskInput('Doomed'))
    const task = workspace.tasks()[0]
    expect(task.lifecycle).toBe(TaskLifecycle.ProvisionFailed)
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })

    const result = bindIssue(deps, { issueId: issueId!, taskId: task.id })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not ready/)
  })

  it('binding an issue to the task it is ALREADY bound to is a no-op: no new upsert, no new event', async () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })
    const id = issueId!
    bindIssue(deps, { issueId: id, taskId: task.id })
    const upsertCountBefore = persistence.upsertedIssues.length
    const eventCountBefore = bus.events.length

    const result = bindIssue(deps, { issueId: id, taskId: task.id })

    expect(result).toEqual({ ok: true })
    expect(persistence.upsertedIssues).toHaveLength(upsertCountBefore)
    expect(bus.events).toHaveLength(eventCountBefore)
  })

  it('rebinding an issue from task A to task B frees A for a different issue', async () => {
    const { deps, workspace } = makeDeps()
    await createTask(deps, taskInput('A'))
    await createTask(deps, taskInput('B'))
    const taskA = workspace.tasks()[0]
    const taskB = workspace.tasks()[1]
    const issue1 = createIssue(deps, { name: 'Issue 1', description: '' }).issueId!
    const issue2 = createIssue(deps, { name: 'Issue 2', description: '' }).issueId!
    bindIssue(deps, { issueId: issue1, taskId: taskA.id })

    const rebind = bindIssue(deps, { issueId: issue1, taskId: taskB.id })
    expect(rebind).toEqual({ ok: true })
    expect(workspace.issue(issue1)!.taskId).toBe(taskB.id)

    // Task A is now free: issue2 can bind to it without "already linked".
    const result = bindIssue(deps, { issueId: issue2, taskId: taskA.id })
    expect(result).toEqual({ ok: true })
    expect(workspace.issue(issue2)!.taskId).toBe(taskA.id)
  })

  it('restores the issue to its pre-bind taskId/status if the persist transaction throws, and rethrows', async () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })
    const id = issueId!
    const issueUpsertedBefore = bus.ofType('issueUpserted').length
    const diskError = new Error('disk full')
    persistence.upsertIssue = () => {
      throw diskError
    }

    expect(() => bindIssue(deps, { issueId: id, taskId: task.id })).toThrow(diskError)

    const issue = workspace.issue(id)!
    expect(issue.taskId).toBeUndefined()
    expect(issue.status).toBe(IssueStatus.Todo)
    // m2: the failed attempt published nothing — bindIssue only publishes AFTER
    // the transaction (bind + upsertIssue) succeeds.
    expect(bus.ofType('issueUpserted')).toHaveLength(issueUpsertedBefore)
  })

  it('m2: a REBIND persist failure restores the issue to its PRIOR task/status (not undefined/Todo)', async () => {
    const { deps, workspace, bus } = makeDeps()
    await createTask(deps, taskInput('A'))
    await createTask(deps, taskInput('B'))
    const taskA = workspace.tasks()[0]
    const taskB = workspace.tasks()[1]
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })
    const id = issueId!
    const firstBind = bindIssue(deps, { issueId: id, taskId: taskA.id })
    expect(firstBind).toEqual({ ok: true })
    expect(workspace.issue(id)!.taskId).toBe(taskA.id)
    expect(workspace.issue(id)!.status).toBe(IssueStatus.InProgress)
    const issueUpsertedBefore = bus.ofType('issueUpserted').length
    const diskError = new Error('disk full')
    deps.persistence.upsertIssue = () => {
      throw diskError
    }

    expect(() => bindIssue(deps, { issueId: id, taskId: taskB.id })).toThrow(diskError)

    const issue = workspace.issue(id)!
    expect(issue.taskId).toBe(taskA.id)
    expect(issue.status).toBe(IssueStatus.InProgress)
    expect(bus.ofType('issueUpserted')).toHaveLength(issueUpsertedBefore)
  })

  it('m11: rejects binding to a task still Provisioning (not just ProvisionFailed) — no tasks row yet', async () => {
    const { deps, workspace } = makeDeps()
    // Deliberately not awaited: `createTask` synchronously marks the task
    // Provisioning and adds it to the workspace BEFORE its first await (the
    // worktree-provider call), so it is observable mid-flight right here.
    const createPromise = createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    expect(task.lifecycle).toBe(TaskLifecycle.Provisioning)
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })

    const result = bindIssue(deps, { issueId: issueId!, taskId: task.id })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not ready/)

    await createPromise
  })

  it('returns { ok: false } for a nonexistent issue id', async () => {
    const { deps, workspace } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]

    const result = bindIssue(deps, { issueId: asIssueId('ghost'), taskId: task.id })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('returns { ok: false } for a nonexistent task id', () => {
    const { deps } = makeDeps()
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })

    const result = bindIssue(deps, { issueId: issueId!, taskId: asTaskId('ghost') })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })
})
