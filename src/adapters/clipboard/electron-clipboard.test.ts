import { describe, it, expect, beforeEach, vi } from 'vitest'
import { clipboard } from 'electron'

// Mock Electron's clipboard module: the real one can't load outside an Electron
// runtime, and we only need to assert the adapter delegates to it. The factory is
// hoisted, so it defines its own mocks; we read them back via the mocked import.
vi.mock('electron', () => ({
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() }
}))

import { ElectronClipboard } from './electron-clipboard'

const readText = vi.mocked(clipboard.readText)
const writeText = vi.mocked(clipboard.writeText)

describe('ElectronClipboard', () => {
  beforeEach(() => {
    readText.mockClear()
    writeText.mockClear()
  })

  it('readText delegates to the Electron clipboard', () => {
    readText.mockReturnValueOnce('hello')
    expect(new ElectronClipboard().readText()).toBe('hello')
    expect(readText).toHaveBeenCalledOnce()
  })

  it('writeText delegates to the Electron clipboard', () => {
    new ElectronClipboard().writeText('world')
    expect(writeText).toHaveBeenCalledWith('world')
  })
})
