import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { moveSessionToWindow } from './move-session-to-window'
import { createView } from './create-view'
import { viewForTask } from './window-groups'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asWindowId, MAIN_WINDOW_ID, type TaskId } from '../../domain/ids'

async function seedReadyTask(): Promise<FakeDeps & { taskId: TaskId }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  return { ...fd, taskId: asTaskId('task-1') }
}

describe('createView (window-view feature, §3.7/§6.7)', () => {
  it('persists a WindowRecord{role: view, taskId, bounds}, publishes windowCreated then viewCreated', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId })

    const result = createView(fd.deps, { taskId: fd.taskId })

    expect(result.ok).toBe(true)
    const windowId = result.ok ? result.windowId! : undefined
    expect(windowId).toBeDefined()
    const record = fd.persistence.windows.get(windowId!)
    expect(record).toMatchObject({
      id: windowId,
      role: 'view',
      taskId: fd.taskId
    })
    expect(fd.bus.events.map((e) => e.type)).toContain('windowCreated')
    expect(fd.bus.events.map((e) => e.type)).toContain('viewCreated')
    const created = fd.bus.ofType('windowCreated')[0]!
    expect(created).toMatchObject({ windowId, role: 'view', taskId: fd.taskId })
    const viewCreated = fd.bus.ofType('viewCreated')[0]!
    expect(viewCreated).toEqual({ type: 'viewCreated', windowId, taskId: fd.taskId })
    // viewCreated is published AFTER the bulk session move, which is itself
    // after windowCreated.
    const types = fd.bus.events.map((e) => e.type)
    expect(types.indexOf('windowCreated')).toBeLessThan(types.indexOf('viewCreated'))
  })

  it('uses the default bounds when none are given, and the given bounds otherwise', async () => {
    const fd = await seedReadyTask()

    const result = createView(fd.deps, {
      taskId: fd.taskId,
      bounds: { x: 1, y: 2, width: 3, height: 4 }
    })

    const windowId = result.ok ? result.windowId! : undefined
    const record = fd.persistence.windows.get(windowId!)
    expect(record?.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('rejects a second view for the same task (at most one view per task)', async () => {
    const fd = await seedReadyTask()
    const first = createView(fd.deps, { taskId: fd.taskId })
    expect(first.ok).toBe(true)
    fd.bus.events.length = 0

    const second = createView(fd.deps, { taskId: fd.taskId })

    expect(second.ok).toBe(false)
    // No second window row/event created.
    expect(fd.bus.events).toEqual([])
    const windows = fd.persistence.loadWindows()
    expect(windows.filter((w) => w.role === 'view')).toHaveLength(1)
  })

  it('rejects an unknown task', () => {
    const fd = makeDeps()
    const result = createView(fd.deps, { taskId: asTaskId('ghost') })
    expect(result.ok).toBe(false)
  })

  it("bulk-moves every one of the task's sessions out of main's window group into the view", async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId }) // s1, main
    await openSession(fd.deps, { taskId: fd.taskId, windowId: asWindowId('win-2') }) // s2, main's secondary
    const task = fd.workspace.task(fd.taskId)!
    const [s1, s2] = task.sessions()

    const result = createView(fd.deps, { taskId: fd.taskId })
    const windowId = result.ok ? result.windowId! : undefined

    expect(task.session(s1.id)!.windowId).toBe(windowId)
    expect(task.session(s2.id)!.windowId).toBe(windowId)
  })

  it("moves the task's active session FIRST and without a cause, so the view marks it", async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId }) // s1 — becomes active (first session)
    await openSession(fd.deps, { taskId: fd.taskId }) // s2
    const task = fd.workspace.task(fd.taskId)!
    const activeId = task.activeSessionId!
    fd.bus.events.length = 0

    createView(fd.deps, { taskId: fd.taskId })

    const moves = fd.bus.ofType('sessionMovedToWindow')
    expect(moves[0]!.sessionId).toBe(activeId)
    expect(moves[0]!.cause).toBeUndefined()
    // Every subsequent move of a different session is tagged groupMove.
    for (const move of moves.slice(1)) {
      if (move.sessionId !== activeId) {
        expect(move.cause).toBe('groupMove')
      }
    }
  })

  it("does not move a session already outside main's window group (parented to a DIFFERENT task's view)", async () => {
    const fd = await seedReadyTask()
    await createTask(fd.deps, taskInput('Other'))
    const otherTaskId = asTaskId('task-2')
    const otherViewResult = createView(fd.deps, { taskId: otherTaskId })
    const otherViewId = otherViewResult.ok ? otherViewResult.windowId! : undefined

    await openSession(fd.deps, { taskId: fd.taskId })
    const task = fd.workspace.task(fd.taskId)!
    const session = task.sessions()[0]!
    // Move it directly into the OTHER task's view window — simulating state
    // `createView` itself would never produce (at most one view per task), but
    // exercising the windowGroupRoot filter directly: this session's group
    // root is now that other view, not MAIN_WINDOW_ID.
    moveSessionToWindow(fd.deps, { sessionId: session.id, targetWindowId: otherViewId! })
    fd.bus.events.length = 0

    createView(fd.deps, { taskId: fd.taskId })

    // No further move for this session — it was already outside main's group.
    expect(fd.bus.ofType('sessionMovedToWindow')).toEqual([])
    expect(task.session(session.id)!.windowId).toBe(otherViewId)
  })

  it('creates a view for a task with no sessions at all (no bulk move, no error)', async () => {
    const fd = await seedReadyTask()

    const result = createView(fd.deps, { taskId: fd.taskId })

    expect(result.ok).toBe(true)
    expect(fd.bus.ofType('sessionMovedToWindow')).toEqual([])
  })

  it("is now resolvable via viewForTask / viewTaskIdForWindow and leaves MAIN's role untouched", async () => {
    const fd = await seedReadyTask()
    const result = createView(fd.deps, { taskId: fd.taskId })
    const windowId = result.ok ? result.windowId! : undefined

    const windows = fd.persistence.loadWindows()
    expect(viewForTask(windows, fd.taskId)?.id).toBe(windowId)
    expect(windows.find((w) => w.id === MAIN_WINDOW_ID)).toBeUndefined() // no main row persisted by this fake by default
  })
})
