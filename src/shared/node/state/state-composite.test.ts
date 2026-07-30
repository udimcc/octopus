import { describe, it, expect, beforeEach } from 'vitest'
import { CompositeStateProvider, type CompositeClock } from './state-composite'
import { createDefaultDetectorRegistry, type CoreStateChange } from './state-core'
import type { ForegroundInfo } from './proc-stat'

/**
 * A controllable clock: `now` is a mutable field the test advances, and the single
 * poll callback registered by the composite is captured so the test can `advance()`
 * it deterministically (no wall time, no real timers).
 */
class FakeClock implements CompositeClock {
  ms = 1_000_000
  private poll: (() => void) | null = null

  now(): number {
    return this.ms
  }
  setInterval(fn: () => void): unknown {
    this.poll = fn
    return 1
  }
  clearInterval(): void {
    this.poll = null
  }
  /** Advance time by `ms` and fire the poll once (mirrors one 200 ms tick). */
  advance(ms: number): void {
    this.ms += ms
    this.poll?.()
  }
}

/**
 * The structural sentinel is injected so the tests are platform-independent. A
 * mutable `fg` field lets a test flip between "shell at its prompt" (Claude gone)
 * and "a child holds the foreground" (Claude running), which is the ONLY structural
 * input the Claude-only model consumes (§9.1).
 */
const RUNNING: ForegroundInfo = { atPrompt: false, foregroundPgid: 4242, comm: 'claude' }
const AT_PROMPT: ForegroundInfo = { atPrompt: true, foregroundPgid: 111, comm: 'bash' }

describe('CompositeStateProvider — Claude-only decision ladder (§9.1)', () => {
  let clock: FakeClock
  let changes: CoreStateChange[]
  let fg: ForegroundInfo | undefined
  let provider: CompositeStateProvider

  const build = (): void => {
    provider = new CompositeStateProvider({
      shellPid: 1234,
      registry: createDefaultDetectorRegistry(),
      clock,
      resolveForeground: () => fg
    })
    provider.onStateChange((c) => changes.push(c))
  }

  beforeEach(() => {
    clock = new FakeClock()
    changes = []
    fg = RUNNING
    build()
  })

  const last = (): CoreStateChange | undefined => changes[changes.length - 1]

  it('a child in the foreground with no explicit signal yet stays unknown (no icon)', () => {
    // The first evaluation with a running child but no signal must not emit an icon.
    expect(last()).toBeUndefined()
  })

  it('an explicit working signal wins immediately (L3, authoritative)', () => {
    provider.submitExplicit({ state: 'working', reason: 'pre_tool' })
    expect(last()).toMatchObject({ state: 'working', layer: 3, confidence: 'authoritative' })
  })

  it('blocked is emitted immediately with no debounce', () => {
    provider.submitExplicit({ state: 'working' })
    changes.length = 0
    provider.submitExplicit({ state: 'blocked', reason: 'notification' })
    expect(last()).toMatchObject({ state: 'blocked', layer: 3 })
  })

  it('waiting → working transitions immediately', () => {
    provider.submitExplicit({ state: 'waiting' })
    expect(last()?.state).toBe('waiting')
    provider.submitExplicit({ state: 'working' })
    expect(last()?.state).toBe('working')
  })

  it('an explicit signal is STICKY across poll ticks — it never goes stale (bug 2.2)', () => {
    provider.submitExplicit({ state: 'waiting', reason: 'claude_stop' })
    expect(last()?.state).toBe('waiting')
    changes.length = 0
    // Many minutes of silence with the child still in the foreground: the state must
    // NOT flap to working or unknown. This is the core regression for the flapping bug.
    for (let i = 0; i < 100; i++) {
      clock.advance(1_000)
    }
    expect(changes).toEqual([])
    expect(provider['current']).toBe('waiting')
  })

  it('returning to the shell prompt clears the sticky explicit → unknown', () => {
    provider.submitExplicit({ state: 'waiting' })
    expect(last()?.state).toBe('waiting')
    // Claude exits: the shell is back at its own prompt.
    fg = AT_PROMPT
    clock.advance(200)
    expect(last()).toMatchObject({ state: 'unknown', reason: 'at_prompt' })
  })

  it('a plain shell (at prompt) is always unknown even after an explicit signal', () => {
    fg = AT_PROMPT
    changes.length = 0
    provider.submitExplicit({ state: 'working' })
    // The at-prompt sentinel wins: the signal is dropped, state stays unknown.
    expect(last()?.state ?? 'unknown').toBe('unknown')
    expect(provider['current']).toBe('unknown')
  })

  it('no /proc read (dead pid / non-Linux) → unknown', () => {
    fg = undefined
    changes.length = 0
    provider.submitExplicit({ state: 'working' })
    expect(provider['current']).toBe('unknown')
  })

  it('a fed OSC 9000 explicit flips state in-band', () => {
    provider.feedOutput('\x1b]9000;{"state":"blocked","reason":"perm"}\x07')
    expect(last()).toMatchObject({ state: 'blocked' })
  })

  it('dispose stops the poll: later advances emit nothing', () => {
    provider.submitExplicit({ state: 'working' })
    provider.dispose()
    changes.length = 0
    clock.advance(60_000)
    expect(changes).toEqual([])
  })
})
