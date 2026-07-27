import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
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
})
