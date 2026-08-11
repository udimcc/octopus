import { describe, it, expect, vi } from 'vitest'

// composition-root.ts imports `electron` (BrowserWindow) at module scope, which
// can't load outside an Electron runtime. We only exercise the PURE
// `resolveNotificationTargetWindow` helper, so a minimal stub suffices.
vi.mock('electron', () => ({ BrowserWindow: {}, app: {}, clipboard: {} }))

import { resolveNotificationTargetWindow } from './composition-root'
import { asWindowId, MAIN_WINDOW_ID } from '../domain/ids'

describe('resolveNotificationTargetWindow (§9.5)', () => {
  const secondary = asWindowId('window-2')
  const windowIds = new Map<number, ReturnType<typeof asWindowId>>([
    [1, MAIN_WINDOW_ID],
    [2, secondary]
  ])

  it('returns the focused window when its webContents id maps to a known window', () => {
    expect(resolveNotificationTargetWindow(2, windowIds, MAIN_WINDOW_ID)).toBe(secondary)
  })

  it('falls back to main when no window is focused (app blurred)', () => {
    expect(resolveNotificationTargetWindow(undefined, windowIds, MAIN_WINDOW_ID)).toBe(
      MAIN_WINDOW_ID
    )
  })

  it('falls back to main when the focused surface is not a tracked window (e.g. devtools)', () => {
    expect(resolveNotificationTargetWindow(99, windowIds, MAIN_WINDOW_ID)).toBe(MAIN_WINDOW_ID)
  })
})
