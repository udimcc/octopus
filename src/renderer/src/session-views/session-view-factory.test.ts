import { describe, it, expect } from 'vitest'
import { resolveSessionView } from './session-view-factory'
import { TerminalPane } from '../terminal/TerminalPane'

describe('resolveSessionView (§8 seam)', () => {
  it('maps the terminal type to TerminalPane', () => {
    expect(resolveSessionView('terminal')).toBe(TerminalPane)
  })

  it('returns undefined for a type this version has no view for (V3 jenkins seam)', () => {
    expect(resolveSessionView('jenkins')).toBeUndefined()
    expect(resolveSessionView('nonsense')).toBeUndefined()
  })
})
