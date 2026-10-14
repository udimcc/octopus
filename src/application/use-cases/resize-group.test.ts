import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
import { resizeGroup } from './resize-group'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asGroupId } from '../../domain/ids'
import { InvariantViolationError } from '../../domain/errors'

async function seedTaskWithSessions(
  n: number
): Promise<FakeDeps & { taskId: ReturnType<typeof asTaskId> }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  for (let i = 0; i < n; i++) {
    await openSession(fd.deps, { taskId })
  }
  return { ...fd, taskId }
}

describe('resizeGroup (§5.7)', () => {
  it('sets the ratio of the root split node (2-member group -> path [])', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    fd.bus.events.length = 0

    resizeGroup(fd.deps, { taskId: fd.taskId, groupId, path: [], ratio: 0.3 })

    const group = task.groupOf(s1.id)!
    expect(group.tree).toMatchObject({ kind: 'split', ratio: 0.3 })
  })

  it('clamps an out-of-range ratio into [0.1, 0.9]', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id

    resizeGroup(fd.deps, { taskId: fd.taskId, groupId, path: [], ratio: 0.99 })

    expect(task.groupOf(s1.id)!.tree).toMatchObject({ ratio: 0.9 })
  })

  it('persists the group diff and publishes only groupsChanged (no sessionReordered, no session-row writes)', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    fd.bus.events.length = 0
    const upsertsBefore = fd.persistence.upsertedSessions.length

    resizeGroup(fd.deps, { taskId: fd.taskId, groupId, path: [], ratio: 0.25 })

    expect(fd.persistence.upsertedSessions.length).toBe(upsertsBefore)
    expect(fd.persistence.groups.get(groupId)?.group.tree).toMatchObject({ ratio: 0.25 })
    expect(fd.bus.events).toEqual([
      { type: 'groupsChanged', taskId: fd.taskId, groups: task.groups() }
    ])
  })

  it('throws InvariantViolationError for an unknown task', () => {
    const { deps } = makeDeps()
    expect(() =>
      resizeGroup(deps, {
        taskId: asTaskId('ghost'),
        groupId: asGroupId('g1'),
        path: [],
        ratio: 0.5
      })
    ).toThrow(InvariantViolationError)
  })

  it('throws InvariantViolationError for an unknown group id', async () => {
    const fd = await seedTaskWithSessions(1)
    expect(() =>
      resizeGroup(fd.deps, { taskId: fd.taskId, groupId: asGroupId('ghost'), path: [], ratio: 0.5 })
    ).toThrow(InvariantViolationError)
  })

  it('throws InvariantViolationError for a bad path (delegated to group-tree.setRatio)', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id

    expect(() =>
      resizeGroup(fd.deps, { taskId: fd.taskId, groupId, path: ['a', 'a'], ratio: 0.5 })
    ).toThrow(InvariantViolationError)
  })

  it('throws InvariantViolationError for a non-finite ratio', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id

    expect(() =>
      resizeGroup(fd.deps, { taskId: fd.taskId, groupId, path: [], ratio: NaN })
    ).toThrow(InvariantViolationError)
  })
})
