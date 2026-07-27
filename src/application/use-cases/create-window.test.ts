import { describe, it, expect } from 'vitest'
import { createWindow, DEFAULT_WINDOW_BOUNDS } from './create-window'
import { makeDeps } from './test-fakes'
import { asWindowId } from '../../domain/ids'

describe('createWindow (§3.7, §6.7)', () => {
  it('mints a window id, persists a secondary WindowRecord, and emits windowCreated', () => {
    const fd = makeDeps()
    const bounds = { x: 100, y: 200, width: 900, height: 640 }

    const windowId = createWindow(fd.deps, { role: 'secondary', bounds })

    // SeqIdGenerator hands out window-1 first.
    expect(windowId).toBe(asWindowId('window-1'))

    const record = fd.persistence.windows.get(windowId)
    expect(record).toEqual({
      id: windowId,
      role: 'secondary',
      bounds,
      createdAt: fd.clock.now()
    })

    const created = fd.bus.ofType('windowCreated')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ windowId, role: 'secondary', bounds })
  })

  it('falls back to the default geometry when no bounds are given', () => {
    const fd = makeDeps()

    const windowId = createWindow(fd.deps, { role: 'secondary' })

    expect(fd.persistence.windows.get(windowId)!.bounds).toEqual(DEFAULT_WINDOW_BOUNDS)
    expect(fd.bus.ofType('windowCreated')[0].bounds).toEqual(DEFAULT_WINDOW_BOUNDS)
  })
})
