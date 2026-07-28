import { describe, it, expect } from 'vitest'
import { OutputBatcher, type BatcherTimers } from './output-batcher'

/** A controllable timer surface: `fire()` runs the single pending timer callback. */
function fakeTimers(): BatcherTimers & { fire: () => void; pending: () => boolean } {
  let cb: (() => void) | null = null
  return {
    setTimer: (fn) => {
      cb = fn
      return 1
    },
    clearTimer: () => {
      cb = null
    },
    fire: () => {
      const f = cb
      cb = null
      f?.()
    },
    pending: () => cb !== null
  }
}

describe('OutputBatcher (§6.6)', () => {
  it('coalesces multiple pushes into one flush on the timer', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers, leadingEdge: false })

    b.push('a')
    b.push('b')
    b.push('c')
    // Nothing emitted until the interval fires.
    expect(out).toEqual([])
    expect(timers.pending()).toBe(true)

    timers.fire()
    expect(out).toEqual(['abc'])
    // Timer cleared after flush.
    expect(timers.pending()).toBe(false)
  })

  it('schedules only one timer across a burst (idempotent while pending)', () => {
    let scheduled = 0
    const timers: BatcherTimers = {
      setTimer: () => {
        scheduled++
        return scheduled
      },
      clearTimer: () => undefined
    }
    const b = new OutputBatcher(() => undefined, { timers })
    b.push('a')
    b.push('b')
    b.push('c')
    expect(scheduled).toBe(1)
  })

  it('flushes immediately (no timer wait) once the byte cap is reached', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers, maxBytes: 4, leadingEdge: false })

    b.push('ab') // 2 bytes, under cap → timer scheduled
    expect(out).toEqual([])
    b.push('cd') // now 4 bytes ≥ cap → immediate flush
    expect(out).toEqual(['abcd'])
    // The immediate flush cancels the pending timer.
    expect(timers.pending()).toBe(false)
  })

  it('counts UTF-8 bytes, not characters, for the cap', () => {
    const timers = fakeTimers()
    const out: string[] = []
    // '€' is 3 UTF-8 bytes; a cap of 4 means two of them (6 bytes) trips it.
    const b = new OutputBatcher((d) => out.push(d), { timers, maxBytes: 4, leadingEdge: false })
    b.push('€') // 3 bytes < 4 → scheduled, not flushed
    expect(out).toEqual([])
    b.push('€') // 6 bytes ≥ 4 → flush
    expect(out).toEqual(['€€'])
  })

  it('ignores empty pushes (no timer, no flush)', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers })
    b.push('')
    expect(timers.pending()).toBe(false)
    timers.fire()
    expect(out).toEqual([])
  })

  it('flush() is a no-op when nothing is queued', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers })
    b.flush()
    expect(out).toEqual([])
  })

  it('dispose() drops pending data without flushing and cancels the timer', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers, leadingEdge: false })
    b.push('lost')
    b.dispose()
    expect(timers.pending()).toBe(false)
    // Firing a stale timer after dispose emits nothing.
    timers.fire()
    expect(out).toEqual([])
  })

  it('re-arms the timer for the next batch after a flush', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers, leadingEdge: false })
    b.push('one')
    timers.fire()
    b.push('two')
    expect(timers.pending()).toBe(true)
    timers.fire()
    expect(out).toEqual(['one', 'two'])
  })
})

describe('OutputBatcher leading edge (§6.6/§11, default)', () => {
  it('flushes the first chunk on an idle buffer immediately, then arms a trailing timer', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers })

    b.push('x') // idle buffer → instant echo
    expect(out).toEqual(['x'])
    // A trailing window is open so follow-ups within it coalesce.
    expect(timers.pending()).toBe(true)
  })

  it('coalesces chunks that follow within the trailing window into one flush', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers })

    b.push('a') // leads
    b.push('b') // window open → queued
    b.push('c') // queued
    expect(out).toEqual(['a'])
    timers.fire()
    expect(out).toEqual(['a', 'bc'])
    // Window closed after the trailing flush.
    expect(timers.pending()).toBe(false)
  })

  it('leads again after the buffer goes idle', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers })

    b.push('a') // leads
    timers.fire() // window closes with nothing queued (no-op flush)
    expect(out).toEqual(['a'])
    b.push('b') // idle again → leads
    expect(out).toEqual(['a', 'b'])
  })

  it('a lead flush with no follow-up leaves an armed timer that fires harmlessly', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers })

    b.push('a') // leads, arms trailing timer
    expect(out).toEqual(['a'])
    expect(timers.pending()).toBe(true)
    timers.fire() // empty buffer → no-op
    expect(out).toEqual(['a'])
    expect(timers.pending()).toBe(false)
  })

  it('reaching the byte cap while a lead window is open flushes once', () => {
    const timers = fakeTimers()
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d), { timers, maxBytes: 4 })

    b.push('ab') // leads (idle) → emits 'ab', arms timer
    expect(out).toEqual(['ab'])
    b.push('cd') // window open → queued; now 2 bytes... still under cap (pendingBytes reset after lead)
    expect(out).toEqual(['ab'])
    b.push('ef') // 4 bytes ≥ cap → immediate flush of the queued window
    expect(out).toEqual(['ab', 'cdef'])
    expect(timers.pending()).toBe(false)
  })
})
