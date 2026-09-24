import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initEventRouting,
  registerTerminalSink,
  unregisterTerminalSink,
  _resetSinks,
  REPLAY_BUFFER_MAX_BYTES
} from './pty-router'
import type { OctopusAPI } from '../../../shared/ipc'
import type { EventDTO } from '../../../shared/events'

/**
 * Install a fake bridge whose `onEvent` captures the handler so a test can push
 * events synchronously. Returns the captured handler once `initEventRouting` runs.
 */
function fakeBridge(): { emit: (e: EventDTO) => void; unsubscribed: () => boolean } {
  let handler: ((e: EventDTO) => void) | undefined
  let unsubbed = false
  window.octopusAPI = {
    onEvent: vi.fn((h: (e: EventDTO) => void) => {
      handler = h
      return () => {
        unsubbed = true
      }
    })
  } as unknown as OctopusAPI
  return {
    emit: (e) => handler?.(e),
    unsubscribed: () => unsubbed
  }
}

describe('pty-router (§5.2 bypass)', () => {
  beforeEach(() => {
    _resetSinks()
  })

  it('routes ptyData straight to the registered sink, never to applyEvent', () => {
    const bridge = fakeBridge()
    const applyEvent = vi.fn()
    const sink = vi.fn()
    initEventRouting(applyEvent)
    registerTerminalSink('s1', sink)

    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'hello' })
    expect(sink).toHaveBeenCalledWith('hello')
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('routes every non-ptyData event to applyEvent', () => {
    const bridge = fakeBridge()
    const applyEvent = vi.fn()
    initEventRouting(applyEvent)

    const evt: EventDTO = { type: 'taskRenamed', taskId: 't1', name: 'x' }
    bridge.emit(evt)
    expect(applyEvent).toHaveBeenCalledWith(evt)
  })

  it('buffers ptyData for a session with no live sink, never routing it to applyEvent', () => {
    const bridge = fakeBridge()
    const applyEvent = vi.fn()
    initEventRouting(applyEvent)
    // No sink registered for s9 → must not throw, must not reach applyEvent (it's
    // held in the pre-mount buffer for replay when the pane mounts).
    expect(() => bridge.emit({ type: 'ptyData', sessionId: 's9', data: 'x' })).not.toThrow()
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('stops delivering to a sink after it is unregistered', () => {
    const bridge = fakeBridge()
    const sink = vi.fn()
    initEventRouting(vi.fn())
    registerTerminalSink('s1', sink)
    unregisterTerminalSink('s1')
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'x' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('registering a new sink for the same session replaces the old one', () => {
    const bridge = fakeBridge()
    const first = vi.fn()
    const second = vi.fn()
    initEventRouting(vi.fn())
    registerTerminalSink('s1', first)
    registerTerminalSink('s1', second)
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'x' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('x')
  })

  it('initEventRouting returns the bridge unsubscribe fn', () => {
    const bridge = fakeBridge()
    const unsubscribe = initEventRouting(vi.fn())
    unsubscribe()
    expect(bridge.unsubscribed()).toBe(true)
  })
})

describe('pty-router pre-mount ring buffer (§6.6 replay)', () => {
  beforeEach(() => {
    _resetSinks()
  })

  it('replays output buffered before the sink mounted, in order, then stops buffering', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())

    // Output arrives before the pane mounts (e.g. a restored session).
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'one' })
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'two' })

    const sink = vi.fn()
    registerTerminalSink('s1', sink)
    // The backlog is replayed on register, oldest-first.
    expect(sink.mock.calls.map((c) => c[0])).toEqual(['one', 'two'])

    // Subsequent live output goes straight through (no double replay).
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'three' })
    expect(sink.mock.calls.map((c) => c[0])).toEqual(['one', 'two', 'three'])
  })

  it('clears the buffer after replay — a re-registered sink does not see it again', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'backlog' })

    const first = vi.fn()
    registerTerminalSink('s1', first)
    expect(first).toHaveBeenCalledWith('backlog')

    unregisterTerminalSink('s1')
    const second = vi.fn()
    registerTerminalSink('s1', second)
    // Backlog was already consumed by `first`; `second` starts clean.
    expect(second).not.toHaveBeenCalled()
  })

  it('does not buffer once a sink is live (output is delivered, not double-shown)', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())
    const sink = vi.fn()
    registerTerminalSink('s1', sink)
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'live' })

    // Re-registering must not replay anything (nothing was buffered).
    const replacement = vi.fn()
    registerTerminalSink('s1', replacement)
    expect(replacement).not.toHaveBeenCalled()
    expect(sink).toHaveBeenCalledWith('live')
  })

  it('bounds the buffer at the byte cap, discarding the OLDEST bytes first', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())

    // A distinctive oldest chunk, then enough to blow past the cap.
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'OLDEST' })
    const big = 'x'.repeat(REPLAY_BUFFER_MAX_BYTES)
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: big })

    const chunks: string[] = []
    registerTerminalSink('s1', (d) => chunks.push(d))

    const replayed = chunks.join('')
    // The oldest chunk was evicted to stay under the cap; the newest survives.
    expect(replayed.includes('OLDEST')).toBe(false)
    expect(replayed.includes('x')).toBe(true)
    expect(replayed.length).toBeLessThanOrEqual(REPLAY_BUFFER_MAX_BYTES)
  })

  it('truncates a SINGLE oversized chunk to its tail (the daemon re-attach replay)', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())

    // On attach the daemon replays a session's whole ring as ONE frame — up to 5 MB, 10×
    // this cap, × every un-mounted session. Chunk eviction can't bound that (there is only
    // one chunk), so the tail is kept.
    const head = 'HEAD'
    const oversized = head + 'x'.repeat(REPLAY_BUFFER_MAX_BYTES * 2) + 'NEWEST'
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: oversized })

    const chunks: string[] = []
    registerTerminalSink('s1', (d) => chunks.push(d))

    const replayed = chunks.join('')
    expect(replayed.length).toBe(REPLAY_BUFFER_MAX_BYTES)
    expect(replayed.endsWith('NEWEST')).toBe(true)
    expect(replayed.includes(head)).toBe(false)
  })

  /**
   * REGRESSION (session restore after a VDI re-login): the daemon re-attach replay is a
   * single multi-megabyte chunk that alone fills the cap, and `warmupSessions()` re-attaches
   * every session BEFORE any window exists — so every replay sits in this buffer waiting for
   * its pane. Under the old chunk-granular eviction, ONE further byte of live output (a
   * Claude repaint, a prompt redraw) evicted the whole replay and the terminal came back
   * blank. The bound must be on bytes: the head chunk is trimmed, not dropped.
   */
  it('keeps the replayed history when live output arrives before the pane mounts', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())

    const replay = 'HISTORY\n' + 'x'.repeat(REPLAY_BUFFER_MAX_BYTES * 10) + 'TAIL-MARKER'
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: replay })
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'L' })

    const chunks: string[] = []
    registerTerminalSink('s1', (d) => chunks.push(d))

    const replayed = chunks.join('')
    expect(replayed.length).toBe(REPLAY_BUFFER_MAX_BYTES)
    expect(replayed).toContain('TAIL-MARKER')
    expect(replayed.endsWith('TAIL-MARKERL')).toBe(true)
  })

  it('keeps a single chunk that fits intact — no truncation at the boundary', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())
    const exact = 'y'.repeat(REPLAY_BUFFER_MAX_BYTES)
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: exact })

    const chunks: string[] = []
    registerTerminalSink('s1', (d) => chunks.push(d))
    expect(chunks.join('')).toBe(exact)
  })

  it('_resetSinks clears pending buffers too', () => {
    const bridge = fakeBridge()
    initEventRouting(vi.fn())
    bridge.emit({ type: 'ptyData', sessionId: 's1', data: 'gone' })
    _resetSinks()

    // After reset, re-init and register: nothing to replay.
    fakeBridge()
    initEventRouting(vi.fn())
    const sink = vi.fn()
    registerTerminalSink('s1', sink)
    expect(sink).not.toHaveBeenCalled()
  })
})
