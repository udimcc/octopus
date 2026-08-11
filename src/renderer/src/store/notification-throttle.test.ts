import { describe, it, expect } from 'vitest'
import { createNotificationThrottle } from './notification-throttle'

/**
 * A controllable timer registry: `setTimer` schedules callbacks; `flush()` fires the ones
 * whose window elapsed (i.e. the cooldown expired → the session goes cold). We model time
 * coarsely — a `flush()` fires every outstanding timer — which is all the leading-edge
 * throttle needs (a rejected `admit` never schedules a new timer, so there is only ever
 * one live timer per hot session). Deterministic (no wall clock).
 */
function fakeTimers() {
  let seq = 0
  const scheduled = new Map<number, () => void>()
  return {
    timers: {
      setTimer(fn: () => void): unknown {
        const id = seq++
        scheduled.set(id, fn)
        return id
      },
      clearTimer(handle: unknown): void {
        scheduled.delete(handle as number)
      }
    },
    /** Fire (and remove) every currently-armed timer (all cooldowns expire). */
    flush(): void {
      const due = [...scheduled.entries()]
      scheduled.clear()
      for (const [, fn] of due) fn()
    },
    pendingCount(): number {
      return scheduled.size
    }
  }
}

describe('createNotificationThrottle (§9.5)', () => {
  it('admits the first change for a cold session (leading edge)', () => {
    const { timers } = fakeTimers()
    const t = createNotificationThrottle({ timers })
    expect(t.admit('s1')).toBe(true)
  })

  it('rejects a second change for the same session while hot', () => {
    const { timers } = fakeTimers()
    const t = createNotificationThrottle({ timers })

    // The bridge burst: turn ended AND needs input → two changes in quick succession.
    expect(t.admit('s1')).toBe(true)
    expect(t.admit('s1')).toBe(false)
    expect(t.admit('s1')).toBe(false)
  })

  it('admits again once the cooldown elapses', () => {
    const { timers, flush } = fakeTimers()
    const t = createNotificationThrottle({ timers })

    expect(t.admit('s1')).toBe(true)
    expect(t.admit('s1')).toBe(false) // rejected (hot)
    flush() // cooldown expires → cold
    expect(t.admit('s1')).toBe(true) // admits again
  })

  it('a rejected admit does NOT extend the window (anchored to the last SHOWN toast)', () => {
    const { timers, flush, pendingCount } = fakeTimers()
    const t = createNotificationThrottle({ timers })

    expect(t.admit('s1')).toBe(true) // admits, arms ONE timer
    expect(pendingCount()).toBe(1)
    expect(t.admit('s1')).toBe(false) // rejected — must not arm a second timer
    expect(pendingCount()).toBe(1)
    flush() // the single window (from the shown toast) expires
    expect(t.admit('s1')).toBe(true) // cold again → admits
  })

  it('throttles per session independently (no cross-session suppression)', () => {
    const { timers } = fakeTimers()
    const t = createNotificationThrottle({ timers })

    expect(t.admit('s1')).toBe(true)
    expect(t.admit('s2')).toBe(true) // different session → its own lead-edge admit
  })

  it('dispose clears pending timers so nothing fires later', () => {
    const { timers, flush, pendingCount } = fakeTimers()
    const t = createNotificationThrottle({ timers })

    expect(t.admit('s1')).toBe(true)
    t.dispose()
    expect(pendingCount()).toBe(0)
    flush() // nothing scheduled
    // Session is cold again (its timer was cleared), so a fresh change admits.
    expect(t.admit('s1')).toBe(true)
  })
})
