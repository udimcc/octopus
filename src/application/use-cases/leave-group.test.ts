import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
import { leaveGroup } from './leave-group'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asSessionId } from '../../domain/ids'
import { InvariantViolationError } from '../../domain/errors'

async function seedGroupedTask(
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

/**
 * The persisted (last-upserted) order of every live session matches the
 * task's current order.
 */
function expectRowsMatch(
  fd: FakeDeps,
  task: { sessions(): readonly { id: unknown; order: number }[] }
) {
  const last = new Map<unknown, number>()
  for (const s of fd.persistence.upsertedSessions) last.set(s.id, s.order)
  const live = task.sessions().map((s) => [s.id, s.order] as const)
  expect(live.every(([id, order]) => last.get(id) === order)).toBe(true)
}

describe('leaveGroup (§5.7)', () => {
  it('removes a member from a 3+ group, keeping the group alive, and publishes groupsChanged then sessionReordered', async () => {
    const fd = await seedGroupedTask(3)
    const [s1, s2, s3] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    joinGroup(fd.deps, { sessionId: s3.id, anchorSessionId: s1.id, dir: 'col' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    fd.bus.events.length = 0

    leaveGroup(fd.deps, { sessionId: s3.id })

    expect(task.groupOf(s3.id)).toBeUndefined()
    expect(task.groupOf(s1.id)?.id).toBe(groupId)
    expect(new Set(task.groupMembers(s1.id))).toEqual(new Set([s1.id, s2.id]))

    // Persisted the (possibly renumbered) session rows and the surviving
    // group's diff — the old test asserted nothing about persistence here
    // (review Finding 1 / U2).
    expectRowsMatch(fd, task)
    expect(fd.persistence.groups.get(groupId)).toEqual({
      taskId: fd.taskId,
      group: {
        id: groupId,
        tree: task.groupOf(s1.id)!.tree,
        colorIndex: task.groupOf(s1.id)!.colorIndex
      }
    })

    expect(fd.bus.events.map((e) => e.type)).toEqual(['groupsChanged', 'sessionReordered'])
    const groupsChanged = fd.bus.events[0]
    if (groupsChanged.type === 'groupsChanged') {
      expect(groupsChanged.groups).toEqual(task.groups())
    }
  })

  it('writes its session rows and group diff inside a single transaction (review U6)', async () => {
    const fd = await seedGroupedTask(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const before = fd.persistence.transactions

    leaveGroup(fd.deps, { sessionId: s2.id })

    expect(fd.persistence.transactions).toBe(before + 1)
  })

  it('dissolves a 2-member group when the second member leaves', async () => {
    const fd = await seedGroupedTask(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    fd.bus.events.length = 0

    leaveGroup(fd.deps, { sessionId: s2.id })

    expect(task.groupOf(s1.id)).toBeUndefined()
    expect(task.groupOf(s2.id)).toBeUndefined()
    expect(task.groups()).toEqual([])
    expect(fd.persistence.groups.has(groupId)).toBe(false)

    expect(fd.bus.events.map((e) => e.type)).toEqual(['groupsChanged', 'sessionReordered'])
    const groupsChanged = fd.bus.events[0]
    if (groupsChanged.type === 'groupsChanged') {
      expect(groupsChanged.groups).toEqual([])
    }
  })

  it('throws InvariantViolationError and writes/publishes nothing for a lone session', async () => {
    const fd = await seedGroupedTask(1)
    const [s1] = fd.workspace.task(fd.taskId)!.sessions()
    const upsertsBefore = fd.persistence.upsertedSessions.length
    fd.bus.events.length = 0

    expect(() => leaveGroup(fd.deps, { sessionId: s1.id })).toThrow(InvariantViolationError)

    // Review Finding 13: a throw before any persistence call must leave the
    // store untouched, not just the bus silent.
    expect(fd.persistence.upsertedSessions.length).toBe(upsertsBefore)
    expect(fd.persistence.groups.size).toBe(0)
    expect(fd.bus.events).toEqual([])
  })

  it('throws InvariantViolationError for an unknown session', async () => {
    const fd = await seedGroupedTask(1)

    expect(() => leaveGroup(fd.deps, { sessionId: asSessionId('ghost') })).toThrow(
      InvariantViolationError
    )
  })
})
