import { describe, it, expect } from 'vitest'
import { debugOverlayChord, defaultKeybindings, primaryModifier } from './keybindings'

/** The pre-mac literal defaults — Linux must keep producing exactly these. */
const LEGACY_LINUX = {
  sessionNextKey: 'Ctrl+Shift+ArrowRight',
  sessionPrevKey: 'Ctrl+Shift+ArrowLeft',
  taskNextKey: 'Ctrl+Shift+ArrowDown',
  taskPrevKey: 'Ctrl+Shift+ArrowUp',
  newSessionKey: 'Ctrl+Shift+KeyN',
  newTaskKey: 'Ctrl+Shift+KeyT',
  closeSessionKey: 'Ctrl+Shift+KeyW',
  searchKey: 'Ctrl+Shift+KeyF',
  copyKey: 'Ctrl+Shift+KeyC',
  pasteKey: 'Ctrl+Shift+KeyV',
  issuesKey: 'Alt+Shift+KeyI',
  splitRightKey: 'Ctrl+Shift+KeyE',
  splitDownKey: 'Ctrl+Shift+KeyO',
  focusPaneLeftKey: 'Ctrl+Shift+KeyH',
  focusPaneRightKey: 'Ctrl+Shift+KeyL',
  focusPaneUpKey: 'Ctrl+Shift+KeyK',
  focusPaneDownKey: 'Ctrl+Shift+KeyJ'
}

/** macOS system / standard-app chords a default must never take. */
const MAC_SYSTEM_CHORDS = [
  'Meta+KeyQ',
  'Meta+KeyW',
  'Meta+KeyH',
  'Meta+KeyM',
  'Meta+Tab',
  'Meta+Backquote',
  'Meta+Space',
  'Meta+Comma',
  'Shift+Meta+Digit3',
  'Shift+Meta+Digit4',
  'Shift+Meta+Digit5',
  'Shift+Meta+KeyQ',
  'Shift+Meta+Slash',
  'Alt+Meta+KeyI' // devtools
]

describe('primaryModifier', () => {
  it('is Meta (Cmd) on darwin and Ctrl elsewhere', () => {
    expect(primaryModifier('darwin')).toBe('Meta')
    expect(primaryModifier('linux')).toBe('Ctrl')
    expect(primaryModifier('win32')).toBe('Ctrl')
  })
})

describe('defaultKeybindings', () => {
  it('reproduces the legacy Linux literals exactly, in the same key order', () => {
    expect(defaultKeybindings('linux')).toEqual(LEGACY_LINUX)
    expect(Object.keys(defaultKeybindings('linux'))).toEqual(Object.keys(LEGACY_LINUX))
    expect(defaultKeybindings('win32')).toEqual(LEGACY_LINUX)
  })

  it('maps every Ctrl+Shift default to canonical Shift+Meta on darwin', () => {
    const mac = defaultKeybindings('darwin')
    for (const [key, linux] of Object.entries(LEGACY_LINUX)) {
      if (!linux.startsWith('Ctrl+Shift+') || key === 'copyKey' || key === 'pasteKey') continue
      expect(mac[key as keyof typeof mac]).toBe(linux.replace('Ctrl+Shift+', 'Shift+Meta+'))
    }
    expect(mac.copyKey).toBe('Meta+KeyC')
    expect(mac.pasteKey).toBe('Meta+KeyV')
    expect(mac.issuesKey).toBe('Shift+Meta+KeyI')
  })

  it('darwin defaults are unique, use Cmd, avoid Ctrl, and avoid macOS system chords', () => {
    const values = Object.values(defaultKeybindings('darwin'))
    expect(new Set(values).size).toBe(values.length)
    for (const chord of values) {
      expect(chord).toContain('Meta')
      expect(chord.startsWith('Ctrl')).toBe(false)
      expect(MAC_SYSTEM_CHORDS).not.toContain(chord)
    }
  })
})

describe('debugOverlayChord', () => {
  it('is Ctrl+Shift+D on Linux and Cmd+Shift+D on darwin', () => {
    expect(debugOverlayChord('linux')).toBe('Ctrl+Shift+KeyD')
    expect(debugOverlayChord('darwin')).toBe('Shift+Meta+KeyD')
    expect(Object.values(defaultKeybindings('darwin'))).not.toContain(debugOverlayChord('darwin'))
  })
})
