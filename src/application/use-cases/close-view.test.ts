import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { createView } from './create-view'
import { closeView } from './close-view'
import { createWindow } from './create-window'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, MAIN_WINDOW_ID, type TaskId, type WindowId } from '../../domain/ids'

async function seedTaskWithView(): Promise<FakeDeps & { taskId: TaskId; viewId: WindowId }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  await openSession(fd.deps, { taskId })
  const result = createView(fd.deps, { taskId })
  const viewId = result.ok ? result.windowId! : (undefined as never)
  return { ...fd, taskId, viewId }
}

describe('closeView (window-view feature, §3.7/§6.7)', () => {
  it('rejects a windowId that is not a view at all', async () => {
    const fd = makeDeps()
    const windowId = createWindow(fd.deps, { role: 'secondary' })

    const result = await closeView(fd.deps, { windowId })

    expect(result.ok).toBe(false)
  })

  it('rejects an unknown windowId', async () => {
    const fd = makeDeps()
    const result = await closeView(fd.deps, { windowId: MAIN_WINDOW_ID })
    expect(result.ok).toBe(false)
  })

  it('moves every session still hosted directly in the view back to main, tagged windowClosed', async () => {
    const fd = await seedTaskWithView()
    fd.bus.events.length = 0

    const result = await closeView(fd.deps, { windowId: fd.viewId })

    expect(result.ok).toBe(true)
    const task = fd.workspace.task(fd.taskId)!
    for (const session of task.sessions()) {
      expect(session.windowId).toBe(MAIN_WINDOW_ID)
    }
    const moves = fd.bus.ofType('sessionMovedToWindow')
    expect(moves.length).toBeGreaterThan(0)
    for (const m of moves) {
      expect(m.cause).toBe('windowClosed')
      expect(m.toWindowId).toBe(MAIN_WINDOW_ID)
    }
  })

  it("deletes the view's window row and publishes windowClosed then viewClosed, before activeTaskChanged", async () => {
    const fd = await seedTaskWithView()
    fd.bus.events.length = 0

    await closeView(fd.deps, { windowId: fd.viewId })

    expect(fd.persistence.windows.has(fd.viewId)).toBe(false)
    const types = fd.bus.events.map((e) => e.type)
    expect(types).toContain('windowClosed')
    expect(types).toContain('viewClosed')
    expect(types.indexOf('windowClosed')).toBeLessThan(types.indexOf('viewClosed'))
    // viewClosed is published before any activeTaskChanged from the auto-switch.
    const viewClosedIdx = types.indexOf('viewClosed')
    const activeTaskChangedIdx = types.indexOf('activeTaskChanged')
    if (activeTaskChangedIdx !== -1) {
      expect(viewClosedIdx).toBeLessThan(activeTaskChangedIdx)
    }
    const viewClosed = fd.bus.ofType('viewClosed')[0]!
    expect(viewClosed).toEqual({ type: 'viewClosed', windowId: fd.viewId, taskId: fd.taskId })
  })

  it('auto-switches main back to the returning task', async () => {
    const fd = await seedTaskWithView()
    // Seed a second task as the "current" active task before closing the view.
    await createTask(fd.deps, taskInput('Other'))
    fd.bus.events.length = 0

    await closeView(fd.deps, { windowId: fd.viewId })

    expect(fd.persistence.activeTaskSet.at(-1)).toBe(fd.taskId)
  })

  it("closes every secondary PARENTED to the view FIRST, landing its sessions back in the view before the view's own move-to-main", async () => {
    const fd = await seedTaskWithView()
    const task = fd.workspace.task(fd.taskId)!
    const viewSession = task.sessions()[0]!
    // Open a second session for T, directly in a secondary parented to the view.
    const secondaryId = createWindow(fd.deps, { role: 'secondary', parentWindowId: fd.viewId })
    await openSession(fd.deps, { taskId: fd.taskId, windowId: secondaryId })
    const secondSession = task.sessions().find((s) => s.id !== viewSession.id)!
    fd.bus.events.length = 0

    await closeView(fd.deps, { windowId: fd.viewId })

    // Both sessions end up back in main.
    expect(task.session(viewSession.id)!.windowId).toBe(MAIN_WINDOW_ID)
    expect(task.session(secondSession.id)!.windowId).toBe(MAIN_WINDOW_ID)
    // The secondary window itself is gone too (closed as part of step 1).
    expect(fd.persistence.windows.has(secondaryId)).toBe(false)
  })
})
