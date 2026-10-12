import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { focusSession } from './focus-session'
import { makeDeps, taskInput } from './test-fakes'
import { asTaskId, asSessionId, asWindowId } from '../../domain/ids'

/** Ready task with two sessions; returns their ids in creation order. */
async function seedTwoSessions(): Promise<{
  fd: Awaited<ReturnType<typeof makeDeps>>
  taskId: ReturnType<typeof asTaskId>
  s1: ReturnType<typeof asSessionId>
  s2: ReturnType<typeof asSessionId>
}> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  await openSession(fd.deps, { taskId })
  await openSession(fd.deps, { taskId })
  const [s1, s2] = fd.workspace
    .task(taskId)!
    .sessions()
    .map((s) => s.id)
  return { fd, taskId, s1, s2 }
}

describe('focusSession (§5.4, I10) — persist-only last-focused pointer', () => {
  it('moves the active-session pointer and persists the task when it changed', async () => {
    const { fd, taskId, s2 } = await seedTwoSessions()
    fd.persistence.upsertedTasks.length = 0

    focusSession(fd.deps, { sessionId: s2 })

    expect(fd.workspace.task(taskId)!.activeSessionId).toBe(s2)
    expect(fd.persistence.upsertedTasks.map((t) => t.id)).toEqual([taskId])
    expect(fd.persistence.upsertedTasks[0]!.activeSessionId).toBe(s2)
  })

  it('does not write when the session is already the pointer', async () => {
    const { fd, taskId, s1 } = await seedTwoSessions()
    // The first-created session is the default active one (I10).
    expect(fd.workspace.task(taskId)!.activeSessionId).toBe(s1)
    fd.persistence.upsertedTasks.length = 0

    focusSession(fd.deps, { sessionId: s1 })

    expect(fd.persistence.upsertedTasks).toEqual([])
  })

  it('publishes NO event (no activeSessionChanged → no broadcast, no window raise)', async () => {
    const { fd, s2 } = await seedTwoSessions()
    fd.bus.events.length = 0

    focusSession(fd.deps, { sessionId: s2 })

    expect(fd.bus.events).toEqual([])
  })

  it('silently ignores an unknown session (a report that raced a close)', () => {
    const fd = makeDeps()
    expect(() => focusSession(fd.deps, { sessionId: asSessionId('ghost') })).not.toThrow()
    expect(fd.persistence.upsertedTasks).toEqual([])
    expect(fd.bus.events).toEqual([])
  })

  it('works for a session hosted in another window', async () => {
    const { fd, taskId, s2 } = await seedTwoSessions()
    fd.workspace.task(taskId)!.session(s2)!.assignToWindow(asWindowId('win-2'))
    fd.persistence.upsertedTasks.length = 0
    fd.bus.events.length = 0

    focusSession(fd.deps, { sessionId: s2 })

    expect(fd.workspace.task(taskId)!.activeSessionId).toBe(s2)
    expect(fd.persistence.upsertedTasks.map((t) => t.id)).toEqual([taskId])
    expect(fd.bus.events).toEqual([])
  })
})
