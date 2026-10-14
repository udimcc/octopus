import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { createIssue } from './create-issue'
import { bindIssue } from './bind-issue'
import { deleteIssue } from './delete-issue'
import { makeDeps, taskInput } from './test-fakes'
import { asIssueId } from '../../domain/ids'
import { TaskLifecycle } from '../../domain/lifecycle'

describe('deleteIssue ("Issues" §13.3)', () => {
  it('deletes an existing issue: persists, removes from the workspace, publishes issueDeleted', () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    const { issueId } = createIssue(deps, { name: 'Gone soon', description: '' })
    const id = issueId!

    const result = deleteIssue(deps, { issueId: id })

    expect(result).toEqual({ ok: true })
    expect(persistence.deletedIssues).toEqual([id])
    expect(workspace.issue(id)).toBeUndefined()
    expect(bus.ofType('issueDeleted').map((e) => e.issueId)).toEqual([id])
  })

  it('is idempotent for an already-gone / never-existed issue id', () => {
    const { deps, persistence, bus } = makeDeps()

    const result = deleteIssue(deps, { issueId: asIssueId('ghost') })

    expect(result).toEqual({ ok: true })
    expect(persistence.deletedIssues).toEqual([])
    expect(bus.ofType('issueDeleted')).toEqual([])
  })

  it('deleting a bound issue leaves the bound task completely untouched', async () => {
    const { deps, workspace } = makeDeps()
    await createTask(deps, taskInput('T'))
    const task = workspace.tasks()[0]
    const { issueId } = createIssue(deps, { name: 'Bound issue', description: '' })
    const id = issueId!
    bindIssue(deps, { issueId: id, taskId: task.id })

    const result = deleteIssue(deps, { issueId: id })

    expect(result).toEqual({ ok: true })
    const taskAfter = workspace.task(task.id)
    expect(taskAfter).toBeDefined()
    expect(taskAfter!.lifecycle).toBe(TaskLifecycle.Ready)
    expect(workspace.tasks()).toHaveLength(1)
  })

  it('rolls back nothing in memory and rethrows if persistence.deleteIssue throws', () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    const { issueId } = createIssue(deps, { name: 'Sturdy', description: '' })
    const id = issueId!
    const issueDeletedBefore = bus.ofType('issueDeleted').length
    const diskError = new Error('disk full')
    persistence.deleteIssue = () => {
      throw diskError
    }

    expect(() => deleteIssue(deps, { issueId: id })).toThrow(diskError)

    expect(workspace.issue(id)).toBeDefined()
    expect(workspace.issues().map((i) => i.id)).toContain(id)
    // m2: nothing was published for the failed attempt — deleteIssue publishes
    // only AFTER both persistence.deleteIssue and workspace.removeIssue succeed.
    expect(bus.ofType('issueDeleted')).toHaveLength(issueDeletedBefore)
  })
})
