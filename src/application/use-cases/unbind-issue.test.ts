import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { createIssue } from './create-issue'
import { bindIssue } from './bind-issue'
import { unbindIssue } from './unbind-issue'
import { makeDeps, taskInput } from './test-fakes'
import { IssueStatus } from '../../domain/issue'
import { asIssueId } from '../../domain/ids'

describe('unbindIssue ("Issues" §13.3, I19)', () => {
  it('clears the binding, leaves status unchanged, persists, and publishes with taskId undefined', async () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })
    const id = issueId!
    bindIssue(deps, { issueId: id, taskId: task.id })
    expect(workspace.issue(id)!.status).toBe(IssueStatus.InProgress)

    const result = unbindIssue(deps, { issueId: id })

    expect(result).toEqual({ ok: true })
    const issue = workspace.issue(id)!
    expect(issue.taskId).toBeUndefined()
    expect(issue.status).toBe(IssueStatus.InProgress)

    const lastUpsert = persistence.upsertedIssues[persistence.upsertedIssues.length - 1]
    expect(lastUpsert.id).toBe(id)
    expect(lastUpsert.taskId).toBeUndefined()

    const lastEvent = bus.ofType('issueUpserted')[bus.ofType('issueUpserted').length - 1]
    expect(lastEvent.issue.taskId).toBeUndefined()
  })

  it('does not touch updatedAt', async () => {
    const { deps, workspace, clock } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })
    const id = issueId!
    bindIssue(deps, { issueId: id, taskId: task.id })
    const updatedAtBefore = workspace.issue(id)!.updatedAt

    clock.t = updatedAtBefore + 10_000
    unbindIssue(deps, { issueId: id })

    expect(workspace.issue(id)!.updatedAt).toBe(updatedAtBefore)
  })

  it('is ok:true for an issue that exists but has no binding (idempotent in effect)', () => {
    const { deps } = makeDeps()
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })

    const result = unbindIssue(deps, { issueId: issueId! })

    expect(result).toEqual({ ok: true })
  })

  it('returns { ok: false } for a NONEXISTENT issue id, unlike deleteIssue idempotent convention', () => {
    const { deps } = makeDeps()

    const result = unbindIssue(deps, { issueId: asIssueId('ghost') })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('m2/m11: a persist failure leaves the binding/Workspace untouched and rethrows (persist-before-mutate)', async () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const { issueId } = createIssue(deps, { name: 'Issue', description: '' })
    const id = issueId!
    bindIssue(deps, { issueId: id, taskId: task.id })
    const issueUpsertedBefore = bus.ofType('issueUpserted').length
    const diskError = new Error('disk full')
    persistence.upsertIssue = () => {
      throw diskError
    }

    expect(() => unbindIssue(deps, { issueId: id })).toThrow(diskError)

    const issue = workspace.issue(id)!
    expect(issue.taskId).toBe(task.id)
    expect(issue.status).toBe(IssueStatus.InProgress)
    // No event published for the failed attempt — only bindIssue's own, from
    // before this call.
    expect(bus.ofType('issueUpserted')).toHaveLength(issueUpsertedBefore)
  })
})
