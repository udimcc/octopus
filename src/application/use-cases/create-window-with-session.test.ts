import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
import { createWindowWithSession } from './create-window-with-session'
import { makeDeps, taskInput } from './test-fakes'
import { asTaskId } from '../../domain/ids'

describe('createWindowWithSession (§3.7, §6.7 — detach onto empty desktop)', () => {
  it('opens a secondary window then moves the session into it, emitting the two events in order', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    const sessionId = fd.workspace.task(taskId)!.sessions()[0].id
    const bounds = { x: 300, y: 300, width: 900, height: 640 }

    const windowId = createWindowWithSession(fd.deps, { sessionId, bounds })

    // The new secondary window exists with the drop-point bounds.
    expect(fd.persistence.windows.get(windowId)).toMatchObject({ role: 'secondary', bounds })
    // The session now lives in it.
    expect(fd.workspace.task(taskId)!.session(sessionId)!.windowId).toBe(windowId)

    // Atomicity: exactly windowCreated THEN sessionMovedToWindow, in that order, so
    // the renderer never sees an empty window flash before the session lands.
    const created = fd.bus.events.findIndex((e) => e.type === 'windowCreated')
    const moved = fd.bus.events.findIndex((e) => e.type === 'sessionMovedToWindow')
    expect(created).toBeGreaterThanOrEqual(0)
    expect(moved).toBeGreaterThan(created)
    expect(fd.bus.ofType('sessionMovedToWindow')[0].toWindowId).toBe(windowId)
  })

  it('sets the detached session as the task persisted active session', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId }) // becomes active by default (first session)
    await openSession(fd.deps, { taskId })
    const task = fd.workspace.task(taskId)!
    const second = task.sessions()[1]

    createWindowWithSession(fd.deps, { sessionId: second.id })

    expect(task.activeSessionId).toBe(second.id)
    expect(
      fd.persistence.upsertedTasks.some((t) => t.id === taskId && t.activeSessionId === second.id)
    ).toBe(true)
  })

  it('detaches a WHOLE group together: a grouped member drags its groupmates into the new window too', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    await openSession(fd.deps, { taskId })
    const task = fd.workspace.task(taskId)!
    const [a, b] = task.sessions()
    joinGroup(fd.deps, { sessionId: b.id, anchorSessionId: a.id, dir: 'row' })

    // Detach via `b`, NOT `a`: `a` is both the default-active session and
    // tab-first, so sending it can't distinguish "the detached member becomes
    // active/sent-first" from "the FIRST member always does" (review Finding
    // 2 / 12).
    const windowId = createWindowWithSession(fd.deps, { sessionId: b.id })

    expect(task.session(a.id)!.windowId).toBe(windowId)
    expect(task.session(b.id)!.windowId).toBe(windowId)
    const moved = fd.bus.ofType('sessionMovedToWindow')
    expect(moved).toHaveLength(2)
    expect(moved.map((e) => [e.sessionId, e.cause])).toEqual([
      [b.id, undefined],
      [a.id, 'groupMove']
    ])
    // Only the directly-detached member becomes the task's active session —
    // even though it was NOT the pre-existing active session.
    expect(task.activeSessionId).toBe(b.id)
  })
})
