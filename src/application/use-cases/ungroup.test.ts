import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
import { ungroup } from './ungroup'
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

describe('ungroup (§5.7)', () => {
  it('dissolves the group entirely, leaving every member lone, with no tab reposition', async () => {
    const fd = await seedTaskWithSessions(3)
    const [s1, s2, s3] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    joinGroup(fd.deps, { sessionId: s3.id, anchorSessionId: s1.id, dir: 'col' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    const orderBefore = task.sessions().map((s) => s.id)
    fd.bus.events.length = 0

    ungroup(fd.deps, { taskId: fd.taskId, groupId })

    expect(task.groupOf(s1.id)).toBeUndefined()
    expect(task.groupOf(s2.id)).toBeUndefined()
    expect(task.groupOf(s3.id)).toBeUndefined()
    expect(task.groups()).toEqual([])
    // No order change — tabs stay exactly where they are.
    expect(task.sessions().map((s) => s.id)).toEqual(orderBefore)
    expect(fd.persistence.groups.has(groupId)).toBe(false)
  })

  it('persists only the group diff (no session-row writes) and publishes only groupsChanged', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    fd.bus.events.length = 0
    const upsertsBefore = fd.persistence.upsertedSessions.length

    ungroup(fd.deps, { taskId: fd.taskId, groupId })

    expect(fd.persistence.upsertedSessions.length).toBe(upsertsBefore)
    expect(fd.bus.events).toEqual([{ type: 'groupsChanged', taskId: fd.taskId, groups: [] }])
  })

  it('leaves other groups of the same task untouched', async () => {
    const fd = await seedTaskWithSessions(4)
    const [s1, s2, s3, s4] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    joinGroup(fd.deps, { sessionId: s4.id, anchorSessionId: s3.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupToDissolve = task.groupOf(s1.id)!.id
    const survivingGroup = task.groupOf(s3.id)!

    ungroup(fd.deps, { taskId: fd.taskId, groupId: groupToDissolve })

    expect(task.groups()).toEqual([survivingGroup])
    expect(fd.persistence.groups.get(survivingGroup.id)).toEqual({
      taskId: fd.taskId,
      group: survivingGroup
    })
  })

  it('throws InvariantViolationError for an unknown task', () => {
    const { deps } = makeDeps()
    expect(() => ungroup(deps, { taskId: asTaskId('ghost'), groupId: asGroupId('g1') })).toThrow(
      InvariantViolationError
    )
  })

  it('throws InvariantViolationError for an unknown group id and writes/publishes nothing', async () => {
    const fd = await seedTaskWithSessions(1)
    fd.bus.events.length = 0

    expect(() => ungroup(fd.deps, { taskId: fd.taskId, groupId: asGroupId('ghost') })).toThrow(
      InvariantViolationError
    )
    expect(fd.bus.events).toEqual([])
  })
})
