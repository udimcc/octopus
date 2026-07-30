import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { switchSession } from './switch-session'
import { makeDeps, taskInput } from './test-fakes'
import { asTaskId, asSessionId, asWindowId } from '../../domain/ids'
import { InvariantViolationError } from '../../domain/errors'

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

describe('switchSession (§5.4)', () => {
  it('moves the active-session pointer, persists the task, and emits activeSessionChanged with the host window', async () => {
    const { fd, taskId, s1, s2 } = await seedTwoSessions()
    // Host s2 in another window so the event carries a non-main windowId.
    fd.workspace.task(taskId)!.session(s2)!.assignToWindow(asWindowId('win-2'))
    fd.persistence.upsertedTasks.length = 0

    switchSession(fd.deps, { sessionId: s2 })

    expect(fd.workspace.task(taskId)!.activeSessionId).toBe(s2)
    // The task was persisted (its active-session pointer moved).
    expect(fd.persistence.upsertedTasks.map((t) => t.id)).toEqual([taskId])
    expect(fd.bus.ofType('activeSessionChanged')).toEqual([
      { type: 'activeSessionChanged', taskId, sessionId: s2, windowId: asWindowId('win-2') }
    ])
    // A previously-active session (s1) is untouched otherwise.
    expect(s1).not.toBe(s2)
  })

  it('still emits (to raise the host window) when the target is already active, without re-persisting', async () => {
    const { fd, taskId, s1 } = await seedTwoSessions()
    // The first-created session is the default active one (I10).
    expect(fd.workspace.task(taskId)!.activeSessionId).toBe(s1)
    fd.persistence.upsertedTasks.length = 0

    switchSession(fd.deps, { sessionId: s1 })

    // No pointer move → no persist, but the event fires so the host window raises.
    expect(fd.persistence.upsertedTasks).toEqual([])
    expect(fd.bus.ofType('activeSessionChanged').map((e) => e.sessionId)).toEqual([s1])
  })

  it('throws for an unknown session', () => {
    const fd = makeDeps()
    expect(() => switchSession(fd.deps, { sessionId: asSessionId('ghost') })).toThrow(
      InvariantViolationError
    )
  })
})
