import { describe, it, expect } from 'vitest'
import {
  hasModifier,
  isModifierCode,
  modifierPrefix,
  parseChord,
  matchesChord,
  chordLabel,
  RESERVED_CHORDS
} from './chords'

/** Build a KeyboardEvent-shaped stub with just the fields the helpers read. */
function ev(code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods
  } as KeyboardEvent
}

describe('hasModifier', () => {
  it('is false for a bare key', () => {
    expect(hasModifier(ev('KeyK'))).toBe(false)
  })

  it('is true when any single modifier is held', () => {
    expect(hasModifier(ev('KeyK', { ctrlKey: true }))).toBe(true)
    expect(hasModifier(ev('KeyK', { altKey: true }))).toBe(true)
    expect(hasModifier(ev('KeyK', { shiftKey: true }))).toBe(true)
    expect(hasModifier(ev('KeyK', { metaKey: true }))).toBe(true)
  })
})

describe('isModifierCode', () => {
  it('is true for the modifier key codes', () => {
    for (const code of ['ControlLeft', 'ControlRight', 'ShiftLeft', 'AltRight', 'MetaLeft']) {
      expect(isModifierCode(code)).toBe(true)
    }
  })

  it('is false for a real (bindable) key', () => {
    expect(isModifierCode('KeyK')).toBe(false)
    expect(isModifierCode('ArrowRight')).toBe(false)
    expect(isModifierCode('Tab')).toBe(false)
  })
})

describe('modifierPrefix', () => {
  it('lists the held modifiers in canonical order', () => {
    expect(modifierPrefix(ev('ControlLeft', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift')
  })

  it('is empty when no modifier is held', () => {
    expect(modifierPrefix(ev('KeyK'))).toBe('')
  })
})

describe('parseChord', () => {
  it('orders modifiers Ctrl+Alt+Shift+Meta then the code', () => {
    const e = ev('KeyK', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })
    expect(parseChord(e)).toBe('Ctrl+Alt+Shift+Meta+KeyK')
  })

  it('emits the code alone when no modifier is held', () => {
    expect(parseChord(ev('ArrowRight'))).toBe('ArrowRight')
  })

  it('produces the canonical default chords', () => {
    expect(parseChord(ev('ArrowRight', { ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Shift+ArrowRight'
    )
  })
})

describe('matchesChord', () => {
  it('matches an equal canonical chord', () => {
    const e = ev('ArrowRight', { ctrlKey: true, shiftKey: true })
    expect(matchesChord(e, 'Ctrl+Shift+ArrowRight')).toBe(true)
  })

  it('does not match when a modifier differs', () => {
    const e = ev('ArrowRight', { ctrlKey: true })
    expect(matchesChord(e, 'Ctrl+Shift+ArrowRight')).toBe(false)
  })

  it('is false for an undefined/empty chord', () => {
    const e = ev('ArrowRight', { ctrlKey: true, shiftKey: true })
    expect(matchesChord(e, undefined)).toBe(false)
    expect(matchesChord(e, '')).toBe(false)
  })
})

describe('chordLabel', () => {
  it('renders arrow glyphs', () => {
    expect(chordLabel('Ctrl+Shift+ArrowRight')).toBe('Ctrl+Shift+→')
    expect(chordLabel('Ctrl+Shift+ArrowLeft')).toBe('Ctrl+Shift+←')
  })

  it('strips the Key/Digit prefix', () => {
    expect(chordLabel('Alt+KeyK')).toBe('Alt+K')
    expect(chordLabel('Ctrl+Digit1')).toBe('Ctrl+1')
  })

  it('renders brackets and leaves other codes as-is', () => {
    expect(chordLabel('Ctrl+Shift+BracketRight')).toBe('Ctrl+Shift+]')
    expect(chordLabel('Ctrl+Shift+Tab')).toBe('Ctrl+Shift+Tab')
  })

  it('is empty for an empty chord', () => {
    expect(chordLabel('')).toBe('')
  })
})

describe('RESERVED_CHORDS', () => {
  it('lists the fixed shortcuts the hook owns', () => {
    const newTerminal = RESERVED_CHORDS.find((r) => r.chord === 'Ctrl+Shift+KeyT')
    expect(newTerminal?.label).toBe('New terminal')
    const nextTask = RESERVED_CHORDS.find((r) => r.chord === 'Ctrl+Shift+BracketRight')
    expect(nextTask?.label).toBe('Next task')
  })
})
