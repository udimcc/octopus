import { describe, it, expect } from 'vitest'
import { windowGroupRoot, viewForTask, secondariesOf, viewTaskIdForWindow } from './window-groups'
import { asWindowId, asTaskId, MAIN_WINDOW_ID } from '../../domain/ids'
import type { WindowRecord } from '../../ports/workspace-persistence'

const BOUNDS = Object.freeze({ x: 0, y: 0, width: 1280, height: 800 })

function winRec(id: string, over: Partial<WindowRecord> = {}): WindowRecord {
  return {
    id: asWindowId(id),
    role: id === 'main' ? 'main' : 'secondary',
    bounds: BOUNDS,
    createdAt: 1000,
    ...over
  }
}

describe('windowGroupRoot (window-view feature)', () => {
  it('resolves an unknown/not-yet-persisted window id to MAIN_WINDOW_ID', () => {
    const windows = [winRec('main')]
    expect(windowGroupRoot(windows, asWindowId('ghost'))).toBe(MAIN_WINDOW_ID)
  })

  it('resolves main itself to MAIN_WINDOW_ID', () => {
    const windows = [winRec('main')]
    expect(windowGroupRoot(windows, MAIN_WINDOW_ID)).toBe(MAIN_WINDOW_ID)
  })

  it('resolves a view window to itself', () => {
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const windows = [winRec('main'), view]
    expect(windowGroupRoot(windows, view.id)).toBe(view.id)
  })

  it("resolves a secondary parented to a view to that view's id", () => {
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const secondary = winRec('sec-1', { parentWindowId: view.id })
    const windows = [winRec('main'), view, secondary]
    expect(windowGroupRoot(windows, secondary.id)).toBe(view.id)
  })

  it('resolves a plain secondary with no parentWindowId to MAIN_WINDOW_ID', () => {
    const secondary = winRec('sec-1')
    const windows = [winRec('main'), secondary]
    expect(windowGroupRoot(windows, secondary.id)).toBe(MAIN_WINDOW_ID)
  })

  it('resolves a secondary whose parentWindowId no longer exists to MAIN_WINDOW_ID', () => {
    const secondary = winRec('sec-1', { parentWindowId: asWindowId('vanished-view') })
    const windows = [winRec('main'), secondary]
    expect(windowGroupRoot(windows, secondary.id)).toBe(MAIN_WINDOW_ID)
  })

  it('resolves a secondary whose parentWindowId names a non-view (e.g. main) to MAIN_WINDOW_ID', () => {
    const secondary = winRec('sec-1', { parentWindowId: MAIN_WINDOW_ID })
    const windows = [winRec('main'), secondary]
    expect(windowGroupRoot(windows, secondary.id)).toBe(MAIN_WINDOW_ID)
  })
})

describe('viewForTask (window-view feature)', () => {
  it("finds the task's dedicated view window", () => {
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const windows = [winRec('main'), view]
    expect(viewForTask(windows, asTaskId('t1'))).toBe(view)
  })

  it('returns undefined when the task has no view', () => {
    const windows = [winRec('main')]
    expect(viewForTask(windows, asTaskId('t1'))).toBeUndefined()
  })

  it("ignores a secondary carrying the task's id by coincidence (only role: 'view' counts)", () => {
    // Secondaries never carry taskId in practice, but the helper filters by role
    // explicitly rather than by taskId presence alone.
    const windows = [winRec('main'), winRec('sec-1')]
    expect(viewForTask(windows, asTaskId('t1'))).toBeUndefined()
  })

  it("picks the right view among several tasks' views", () => {
    const viewA = winRec('view-a', { role: 'view', taskId: asTaskId('ta') })
    const viewB = winRec('view-b', { role: 'view', taskId: asTaskId('tb') })
    const windows = [winRec('main'), viewA, viewB]
    expect(viewForTask(windows, asTaskId('tb'))).toBe(viewB)
  })
})

describe('secondariesOf (window-view feature)', () => {
  it("returns main's parent-less secondaries when rootId is MAIN_WINDOW_ID", () => {
    const secA = winRec('sec-a')
    const secB = winRec('sec-b')
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const windows = [winRec('main'), secA, secB, view]
    expect(secondariesOf(windows, MAIN_WINDOW_ID)).toEqual([secA, secB])
  })

  it('returns only the secondaries parented to a given view', () => {
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const viewSec = winRec('view-sec', { parentWindowId: view.id })
    const mainSec = winRec('main-sec')
    const windows = [winRec('main'), view, viewSec, mainSec]
    expect(secondariesOf(windows, view.id)).toEqual([viewSec])
  })

  it('excludes the root itself and any view (only role: secondary counts)', () => {
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const windows = [winRec('main'), view]
    expect(secondariesOf(windows, MAIN_WINDOW_ID)).toEqual([])
    expect(secondariesOf(windows, view.id)).toEqual([])
  })
})

describe('viewTaskIdForWindow (window-view feature)', () => {
  it("resolves a view window's own id to its pinned task", () => {
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const windows = [winRec('main'), view]
    expect(viewTaskIdForWindow(windows, view.id)).toBe(asTaskId('t1'))
  })

  it("resolves a view's OWN secondary to the SAME pinned task (the under-pinning bug this helper fixes)", () => {
    const view = winRec('view-1', { role: 'view', taskId: asTaskId('t1') })
    const secondary = winRec('sec-1', { parentWindowId: view.id })
    const windows = [winRec('main'), view, secondary]
    expect(viewTaskIdForWindow(windows, secondary.id)).toBe(asTaskId('t1'))
  })

  it('resolves main to undefined', () => {
    const windows = [winRec('main')]
    expect(viewTaskIdForWindow(windows, MAIN_WINDOW_ID)).toBeUndefined()
  })

  it("resolves main's own secondary to undefined", () => {
    const secondary = winRec('sec-1')
    const windows = [winRec('main'), secondary]
    expect(viewTaskIdForWindow(windows, secondary.id)).toBeUndefined()
  })

  it('resolves an unknown window id to undefined', () => {
    const windows = [winRec('main')]
    expect(viewTaskIdForWindow(windows, asWindowId('ghost'))).toBeUndefined()
  })
})
