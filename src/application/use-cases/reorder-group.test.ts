import { describe, it, expect, vi } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
import { reorderGroup } from './reorder-group'
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

describe('reorderGroup (§5.7)', () => {
  it('moves the whole group block as one unit, keeping members adjacent and in relative order', async () => {
    const fd = await seedTaskWithSessions(4)
    const [s1, s2, s3, s4] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    fd.bus.events.length = 0

    reorderGroup(fd.deps, { taskId: fd.taskId, groupId, toIndex: 2 })

    expect(task.sessions().map((s) => s.id)).toEqual([s3.id, s4.id, s1.id, s2.id])
    // Persisted the renumbered session rows (review Finding 1): exact
    // last-written order per id, not just "was written at some point".
    expectRowsMatch(fd, task)
  })

  it('leaves the group tree/color untouched (only order changes) and publishes groupsChanged with the unchanged list, then sessionReordered', async () => {
    const fd = await seedTaskWithSessions(4)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupBefore = task.groupOf(s1.id)!
    fd.bus.events.length = 0

    reorderGroup(fd.deps, { taskId: fd.taskId, groupId: groupBefore.id, toIndex: 2 })

    const groupAfter = task.groupOf(s1.id)!
    expect(groupAfter.tree).toEqual(groupBefore.tree)
    expect(groupAfter.colorIndex).toBe(groupBefore.colorIndex)

    expect(fd.bus.events.map((e) => e.type)).toEqual(['groupsChanged', 'sessionReordered'])
    const [groupsChanged, reordered] = fd.bus.events
    if (groupsChanged.type === 'groupsChanged') {
      expect(groupsChanged.groups).toEqual(task.groups())
    }
    if (reordered.type === 'sessionReordered') {
      expect(reordered.orderedSessionIds).toEqual(task.sessions().map((s) => s.id))
    }
  })

  it('does NOT call upsertGroup — only session rows change (review Finding 11 / U19)', async () => {
    const fd = await seedTaskWithSessions(3)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id
    // A spy, not a size check: `upsertGroup` re-writing the SAME unchanged
    // group row would leave `fd.persistence.groups.size` unchanged too (it's
    // a Map keyed by group id — an overwrite isn't a size change), so a size
    // assertion can't actually tell "wrote nothing" apart from "wrote the
    // same thing again".
    const spy = vi.spyOn(fd.persistence, 'upsertGroup')

    reorderGroup(fd.deps, { taskId: fd.taskId, groupId, toIndex: 0 })

    expect(spy).not.toHaveBeenCalled()
  })

  it('throws InvariantViolationError for an unknown task', () => {
    const { deps } = makeDeps()
    expect(() =>
      reorderGroup(deps, { taskId: asTaskId('ghost'), groupId: asGroupId('g1'), toIndex: 0 })
    ).toThrow(InvariantViolationError)
  })

  it('throws InvariantViolationError for an unknown group id', async () => {
    const fd = await seedTaskWithSessions(1)
    expect(() =>
      reorderGroup(fd.deps, { taskId: fd.taskId, groupId: asGroupId('ghost'), toIndex: 0 })
    ).toThrow(InvariantViolationError)
  })

  it('throws InvariantViolationError for a non-integer/negative toIndex', async () => {
    const fd = await seedTaskWithSessions(2)
    const [s1, s2] = fd.workspace.task(fd.taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1.id)!.id

    expect(() => reorderGroup(fd.deps, { taskId: fd.taskId, groupId, toIndex: -1 })).toThrow(
      InvariantViolationError
    )
    expect(() => reorderGroup(fd.deps, { taskId: fd.taskId, groupId, toIndex: 1.5 })).toThrow(
      InvariantViolationError
    )
  })
})
