import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createScrollbackFlushScheduler,
  SCROLLBACK_FLUSH_INTERVAL_MS
} from './scrollback-flush-scheduler'

describe('createScrollbackFlushScheduler (§6.6)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes every interval once started, and stops on stop()', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const s = createScrollbackFlushScheduler({ flush })
    vi.advanceTimersByTime(SCROLLBACK_FLUSH_INTERVAL_MS)
    expect(flush).not.toHaveBeenCalled() // not started yet
    s.start()
    vi.advanceTimersByTime(SCROLLBACK_FLUSH_INTERVAL_MS - 1)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2 * SCROLLBACK_FLUSH_INTERVAL_MS)
    expect(flush).toHaveBeenCalledTimes(3)
    s.stop()
    vi.advanceTimersByTime(10 * SCROLLBACK_FLUSH_INTERVAL_MS)
    expect(flush).toHaveBeenCalledTimes(3)
  })

  it('start and stop are idempotent (one timer at most)', () => {
    const setInterval = vi.fn(() => 'h')
    const clearInterval = vi.fn()
    const s = createScrollbackFlushScheduler({ flush: vi.fn(), setInterval, clearInterval })
    s.start()
    s.start()
    expect(setInterval).toHaveBeenCalledTimes(1)
    s.stop()
    s.stop()
    expect(clearInterval).toHaveBeenCalledTimes(1)
    expect(clearInterval).toHaveBeenCalledWith('h')
  })

  it('a throwing flush does not kill the timer', () => {
    vi.useFakeTimers()
    const flush = vi.fn(() => {
      throw new Error('boom')
    })
    const s = createScrollbackFlushScheduler({ flush, intervalMs: 10 })
    s.start()
    vi.advanceTimersByTime(30)
    expect(flush).toHaveBeenCalledTimes(3)
    s.stop()
  })
})
