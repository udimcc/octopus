import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asSessionId, asWindowId } from '../../domain/ids'
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

/**
 * The persisted (last-upserted) order of every live session matches the
 * task's current order — not just "the joining session got written somewhere"
 * (a `.some()` check would also pass if every OTHER row were stale/missing).
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

describe('joinGroup (§5.7)', () => {
  it('forms a new group from two lone sessions, persists it, and publishes groupsChanged then sessionReordered', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    fd.bus.events.length = 0

    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })

    const task = fd.workspace.task(fd.taskId)!
    const group = task.groupOf(s1.id)
    expect(group).toBeDefined()
    expect(task.groupOf(s2.id)?.id).toBe(group!.id)
    expect(task.groupMembers(s1.id)).toEqual([s1.id, s2.id])

    // Persisted group diff.
    expect(fd.persistence.groups.get(group!.id)).toEqual({
      taskId: fd.taskId,
      group: { id: group!.id, tree: group!.tree, colorIndex: group!.colorIndex }
    })
    // Persisted the (possibly renumbered) session rows — every live session's
    // last-written row, not just the joining one (review Finding 1 / U1b).
    expectRowsMatch(fd, task)

    expect(fd.bus.events.map((e) => e.type)).toEqual(['groupsChanged', 'sessionReordered'])
    const [groupsChanged, reordered] = fd.bus.events
    if (groupsChanged.type === 'groupsChanged') {
      expect(groupsChanged.taskId).toBe(fd.taskId)
      expect(groupsChanged.groups).toEqual(task.groups())
    }
    if (reordered.type === 'sessionReordered') {
      expect(reordered.orderedSessionIds).toEqual(task.sessions().map((s) => s.id))
    }
  })

  it('extends an existing group when the anchor is already grouped', async () => {
    const fd = await seedTaskWithSessions(3)
    const [s1, s2, s3] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id

    joinGroup(fd.deps, { sessionId: s3.id, anchorSessionId: s1.id, dir: 'col' })

    expect(task.groupOf(s3.id)?.id).toBe(groupId)
    expect(new Set(task.groupMembers(s1.id))).toEqual(new Set([s1.id, s2.id, s3.id]))
  })

  it('persists EVERY renumbered row, not only the joining session (review Finding 1 / U1b)', async () => {
    // s4 joins anchored on s1: s4's tab moves from the far end to right after
    // s1, so s2 and s3 (neither the joiner nor the anchor) shift position too
    // and must be persisted — a mutant that writes only the joining session's
    // row would leave their persisted order stale.
    const fd = await seedTaskWithSessions(4)
    const [s1, s2, s3, s4] = fd.workspace.task(fd.taskId)!.sessions()

    joinGroup(fd.deps, { sessionId: s4.id, anchorSessionId: s1.id, dir: 'row' })

    const task = fd.workspace.task(fd.taskId)!
    // s4 landed right after s1 — moved up ahead of s2 and s3.
    expect(task.sessions().map((s) => s.id)).toEqual([s1.id, s4.id, s2.id, s3.id])
    expectRowsMatch(fd, task)
  })

  it('leaves a different group first when sessionId is already grouped elsewhere', async () => {
    const fd = await seedTaskWithSessions(4)
    const [s1, s2, s3, s4] = fd.workspace.task(fd.taskId)!.sessions()
    const task = fd.workspace.task(fd.taskId)!
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    joinGroup(fd.deps, { sessionId: s4.id, anchorSessionId: s3.id, dir: 'row' })
    const originalGroupId = task.groupOf(s1.id)!.id

    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s3.id, dir: 'col' })

    // s1's old group dissolved (2 members -> 1), so s1 is lone now.
    expect(task.groupOf(s1.id)).toBeUndefined()
    // s2 is now in s3/s4's group.
    const newGroup = task.groupOf(s3.id)!
    expect(newGroup.id).not.toBe(originalGroupId)
    expect(new Set(task.groupMembers(s3.id))).toEqual(new Set([s2.id, s3.id, s4.id]))
    // The dissolved group's row is actually deleted from persistence, not
    // just absent from the live model (review Finding 9 / U5: persistGroups
    // must be given the real `before` list so it can diff out the dissolved
    // group, not an empty list that skips every delete).
    expect(fd.persistence.groups.has(originalGroupId)).toBe(false)
  })

  it('writes its session rows and group diff inside a single transaction (review U4)', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    const before = fd.persistence.transactions

    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })

    expect(fd.persistence.transactions).toBe(before + 1)
  })

  it('throws InvariantViolationError and writes/publishes nothing for an unknown session', async () => {
    const fd = await seedTaskWithSessions(1)
    const [s1] = fd.workspace.task(fd.taskId)!.sessions()
    const upsertsBefore = fd.persistence.upsertedSessions.length
    fd.bus.events.length = 0

    expect(() =>
      joinGroup(fd.deps, { sessionId: asSessionId('ghost'), anchorSessionId: s1.id, dir: 'row' })
    ).toThrow(InvariantViolationError)

    expect(fd.persistence.upsertedSessions.length).toBe(upsertsBefore)
    expect(fd.persistence.groups.size).toBe(0)
    expect(fd.bus.events).toEqual([])
  })

  it('throws when the anchor is in a different window (join enforces one-window membership)', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    const task = fd.workspace.task(fd.taskId)!
    task.moveToWindow(s2.id, asWindowId('win-2'))
    fd.bus.events.length = 0

    expect(() =>
      joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    ).toThrow(InvariantViolationError)
    expect(fd.bus.events).toEqual([])
  })
})
