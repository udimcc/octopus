import { describe, it, expect } from 'vitest'
import {
  InMemoryProgramStateDetectorRegistry,
  ClaudeCodeDetector,
  createDefaultDetectorRegistry,
  type ProgramStateDetector
} from './state-core'

describe('ClaudeCodeDetector (§9.2)', () => {
  const d = new ClaudeCodeDetector()

  it('matches exact and prefixed/truncated claude comm, case-insensitively', () => {
    expect(d.matches('claude')).toBe(true)
    expect(d.matches('Claude')).toBe(true)
    expect(d.matches('claude-code-')).toBe(true) // kernel truncates comm to 15 chars
    expect(d.matches('node')).toBe(false)
    expect(d.matches('bash')).toBe(false)
  })

  it('trusts explicit signals verbatim (§9.2)', () => {
    expect(d.interpret({ state: 'working' })).toBe('working')
    expect(d.interpret({ state: 'waiting' })).toBe('waiting')
    expect(d.interpret({ state: 'blocked' })).toBe('blocked')
  })
})

describe('InMemoryProgramStateDetectorRegistry (§9.3)', () => {
  it('returns the first matching detector (first-match-wins)', () => {
    const first: ProgramStateDetector = {
      name: 'first',
      matches: (c) => c === 'claude',
      interpret: () => 'working'
    }
    const second: ProgramStateDetector = {
      name: 'second',
      matches: (c) => c === 'claude',
      interpret: () => 'waiting'
    }
    const reg = new InMemoryProgramStateDetectorRegistry()
    reg.register(first)
    reg.register(second)
    expect(reg.forComm('claude')?.name).toBe('first')
  })

  it('returns undefined for an unmatched comm and for undefined (the default: verbatim signal)', () => {
    const reg = createDefaultDetectorRegistry()
    expect(reg.forComm('bash')).toBeUndefined()
    expect(reg.forComm(undefined)).toBeUndefined()
  })

  it('createDefaultDetectorRegistry registers exactly the claude detector', () => {
    const reg = createDefaultDetectorRegistry()
    expect(reg.forComm('claude')?.name).toBe('claude')
  })
})
