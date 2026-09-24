import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { moveSessionToWindow } from './move-session-to-window'
import { createWindow } from './create-window'
import { closeWindow } from './close-window'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, MAIN_WINDOW_ID, type WindowId, type SessionId } from '../../domain/ids'
import { SessionLifecycle } from '../../domain/lifecycle'

/**
 * A task with two sessions, both moved into one freshly created secondary window —
 * the state right before that window is closed with live sessions.
 */
async function seedWindowWithTwoSessions(): Promise<
  FakeDeps & { windowId: WindowId; sessionIds: SessionId[] }
> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  await openSession(fd.deps, { taskId })
  await openSession(fd.deps, { taskId })
  const sessionIds = fd.workspace
    .task(taskId)!
    .sessions()
    .map((s) => s.id)

  const windowId = createWindow(fd.deps, { role: 'secondary' })
  for (const id of sessionIds) {
    moveSessionToWindow(fd.deps, { sessionId: id, targetWindowId: windowId })
  }
  return { ...fd, windowId, sessionIds }
}

describe('closeWindow (§3.7, §6.7)', () => {
  it('move-to-main: reassigns every hosted session back to the main window, kills nothing', async () => {
    const fd = await seedWindowWithTwoSessions()
    const runtimes = fd.sessions.created.slice()

    await closeWindow(fd.deps, { windowId: fd.windowId, disposition: 'move-to-main' })

    const task = fd.workspace.task(asTaskId('task-1'))!
    for (const id of fd.sessionIds) {
      const session = task.session(id)!
      // Still alive, still Running, just re-homed to the main window.
      expect(session.windowId).toBe(MAIN_WINDOW_ID)
      expect(session.lifecycle).toBe(SessionLifecycle.Running)
    }
    // No runtime was stopped/disposed.
    expect(runtimes.every((r) => !r.stopped && !r.disposed)).toBe(true)
    expect(fd.persistence.deletedSessions).toEqual([])

    // The window row is gone and windowClosed announced.
    expect(fd.persistence.windows.has(fd.windowId)).toBe(false)
    expect(fd.bus.ofType('windowClosed').map((e) => e.windowId)).toEqual([fd.windowId])
  })

  it('kill-sessions: closes every hosted session (teardown + row delete), then closes the window', async () => {
    const fd = await seedWindowWithTwoSessions()
    const runtimes = fd.sessions.created.slice()

    await closeWindow(fd.deps, { windowId: fd.windowId, disposition: 'kill-sessions' })

    const task = fd.workspace.task(asTaskId('task-1'))!
    // Every hosted session is removed from the task and its runtime torn down.
    for (const id of fd.sessionIds) {
      expect(task.session(id)).toBeUndefined()
    }
    expect(runtimes.every((r) => r.stopped && r.disposed)).toBe(true)
    expect(fd.persistence.deletedSessions.sort()).toEqual([...fd.sessionIds].sort())
    expect(
      fd.bus
        .ofType('sessionClosed')
        .map((e) => e.sessionId)
        .sort()
    ).toEqual([...fd.sessionIds].sort())

    expect(fd.persistence.windows.has(fd.windowId)).toBe(false)
    expect(fd.bus.ofType('windowClosed').map((e) => e.windowId)).toEqual([fd.windowId])
  })

  it('closes an empty window (no hosted sessions): just deletes the row and emits windowClosed', async () => {
    const fd = makeDeps()
    const windowId = createWindow(fd.deps, { role: 'secondary' })

    await closeWindow(fd.deps, { windowId, disposition: 'move-to-main' })

    expect(fd.persistence.windows.has(windowId)).toBe(false)
    expect(fd.bus.ofType('windowClosed').map((e) => e.windowId)).toEqual([windowId])
    expect(fd.persistence.deletedSessions).toEqual([])
  })
})
