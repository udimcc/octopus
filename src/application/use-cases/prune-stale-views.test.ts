import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { pruneStaleViews } from './prune-stale-views'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asWindowId, MAIN_WINDOW_ID, type TaskId } from '../../domain/ids'
import type { WindowRecord } from '../../ports/workspace-persistence'

const BOUNDS = Object.freeze({ x: 0, y: 0, width: 1280, height: 800 })

function viewRecord(id: string, taskId: TaskId | undefined): WindowRecord {
  return { id: asWindowId(id), role: 'view', bounds: BOUNDS, createdAt: 1000, taskId }
}

function secondaryRecord(id: string, parentWindowId?: string): WindowRecord {
  return {
    id: asWindowId(id),
    role: 'secondary',
    bounds: BOUNDS,
    createdAt: 1000,
    parentWindowId: parentWindowId !== undefined ? asWindowId(parentWindowId) : undefined
  }
}

async function seedReadyTask(): Promise<FakeDeps & { taskId: TaskId }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  return { ...fd, taskId: asTaskId('task-1') }
}

describe('pruneStaleViews (boot-time reconciliation, window-view feature)', () => {
  it('discards a view whose task no longer exists', () => {
    // `deleteTask` itself already closes a bound view (delete-task.ts) before
    // the task is gone, so a genuinely stale row — the "crash mid-teardown" or
    // "manually edited DB" case this use case guards against — is one whose
    // taskId never resolves in the workspace at all, simulated directly here
    // rather than by deleting a task that had a (self-cleaning) view.
    const fd = makeDeps()
    fd.persistence.upsertWindow(viewRecord('view-1', asTaskId('ghost')))

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('view-1'))).toBe(false)
    expect(fd.bus.ofType('windowClosed').map((e) => e.windowId)).toEqual([asWindowId('view-1')])
  })

  it('discards a view with no taskId at all (defensive, malformed row)', () => {
    const fd = makeDeps()
    fd.persistence.upsertWindow(viewRecord('view-1', undefined))

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('view-1'))).toBe(false)
  })

  it('restores a valid view whose task still exists (no-op)', async () => {
    const fd = await seedReadyTask()
    fd.persistence.upsertWindow(viewRecord('view-1', fd.taskId))
    fd.bus.events.length = 0

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('view-1'))).toBe(true)
    expect(fd.bus.events).toEqual([])
  })

  it('removes a secondary orphaned by its parent view going stale, together with the view', () => {
    const fd = makeDeps()
    fd.persistence.upsertWindow(viewRecord('view-1', asTaskId('ghost')))
    fd.persistence.upsertWindow(secondaryRecord('sec-1', 'view-1'))

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('view-1'))).toBe(false)
    expect(fd.persistence.windows.has(asWindowId('sec-1'))).toBe(false)
  })

  it('removes a secondary whose parentWindowId names no window row at all (dangling link)', () => {
    const fd = makeDeps()
    fd.persistence.upsertWindow(secondaryRecord('sec-1', 'ghost-view'))

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('sec-1'))).toBe(false)
  })

  it('keeps a secondary parented to a STILL-VALID view', async () => {
    const fd = await seedReadyTask()
    fd.persistence.upsertWindow(viewRecord('view-1', fd.taskId))
    fd.persistence.upsertWindow(secondaryRecord('sec-1', 'view-1'))

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('view-1'))).toBe(true)
    expect(fd.persistence.windows.has(asWindowId('sec-1'))).toBe(true)
  })

  it('keeps a plain secondary of main untouched (no parentWindowId)', () => {
    const fd = makeDeps()
    fd.persistence.upsertWindow(secondaryRecord('sec-1'))

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('sec-1'))).toBe(true)
  })

  it('re-homes a session hosted directly in a stale view to MAIN_WINDOW_ID before deleting it', async () => {
    // `createView` only ever moves a task's OWN sessions into its OWN view, so
    // a session surviving directly in a now-stale view (crash mid-teardown,
    // manual DB edit) belonging to some other, still-live task is exactly the
    // defensive case the module doc describes — simulated directly here since
    // no normal command sequence produces it.
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId })
    const task = fd.workspace.task(fd.taskId)!
    const session = task.sessions()[0]!
    task.moveToWindow(session.id, asWindowId('view-1'))
    fd.persistence.upsertWindow(viewRecord('view-1', asTaskId('ghost')))

    pruneStaleViews(fd.deps)

    expect(fd.persistence.windows.has(asWindowId('view-1'))).toBe(false)
    expect(task.session(session.id)!.windowId).toBe(MAIN_WINDOW_ID)
  })

  it('re-homes a session hosted in an orphaned secondary to MAIN_WINDOW_ID', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId, windowId: asWindowId('sec-1') })
    fd.persistence.upsertWindow(secondaryRecord('sec-1', 'ghost-view'))
    const task = fd.workspace.task(fd.taskId)!
    const session = task.sessions()[0]!

    pruneStaleViews(fd.deps)

    expect(task.session(session.id)!.windowId).toBe(MAIN_WINDOW_ID)
    expect(fd.persistence.windows.has(asWindowId('sec-1'))).toBe(false)
  })

  it('does nothing when there is nothing stale (no windows at all)', () => {
    const fd = makeDeps()

    pruneStaleViews(fd.deps)

    expect(fd.bus.events).toEqual([])
  })

  it('never touches activeTaskId (hydrate already resolved it; no switchTask call)', () => {
    const fd = makeDeps()
    fd.persistence.upsertWindow(viewRecord('view-1', asTaskId('ghost')))

    pruneStaleViews(fd.deps)

    expect(fd.bus.ofType('activeTaskChanged')).toEqual([])
  })
})
