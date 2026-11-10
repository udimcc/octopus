import { describe, it, expect } from 'vitest'
import { showUpdatePopup, hasUpdateAvailable } from './update-status'
import type { UpdateStatusDTO } from '../../../shared/dto'

const st = (over: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO => ({
  state: 'available',
  availableVersion: '1.2.0',
  currentVersion: '1.0.0',
  popup: true,
  ...over
})

describe('showUpdatePopup', () => {
  it('shows in the main window when main says popup', () => {
    expect(showUpdatePopup(st(), 'main')).toBe(true)
  })
  it.each(['secondary', 'view'] as const)('never shows in a %s window', (role) => {
    expect(showUpdatePopup(st(), role)).toBe(false)
  })
  it('hidden when popup is false, status null, or no version', () => {
    expect(showUpdatePopup(st({ popup: false }), 'main')).toBe(false)
    expect(showUpdatePopup(null, 'main')).toBe(false)
    expect(showUpdatePopup(st({ availableVersion: undefined }), 'main')).toBe(false)
  })
  it('hidden while that version is snoozed, shown again for a newer one', () => {
    expect(showUpdatePopup(st(), 'main', '1.2.0')).toBe(false)
    expect(showUpdatePopup(st({ availableVersion: '1.3.0' }), 'main', '1.2.0')).toBe(true)
  })
})

describe('hasUpdateAvailable', () => {
  it('true for available and for stale-available while unreachable', () => {
    expect(hasUpdateAvailable(st())).toBe(true)
    expect(hasUpdateAvailable(st({ state: 'unreachable' }))).toBe(true)
  })
  it('false for null, upToDate, or no version', () => {
    expect(hasUpdateAvailable(null)).toBe(false)
    expect(hasUpdateAvailable(st({ state: 'upToDate', availableVersion: undefined }))).toBe(false)
    expect(hasUpdateAvailable(st({ state: 'unreachable', availableVersion: undefined }))).toBe(
      false
    )
  })
})
