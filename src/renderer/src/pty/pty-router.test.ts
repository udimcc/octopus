import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initEventRouting,
  registerTerminalSink,
  unregisterTerminalSink,
  _resetSinks
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

  it('drops ptyData for a session with no live sink', () => {
    const bridge = fakeBridge()
    const applyEvent = vi.fn()
    initEventRouting(applyEvent)
    // No sink registered for s9 → must not throw, must not reach applyEvent.
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
