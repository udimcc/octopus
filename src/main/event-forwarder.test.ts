import { describe, it, expect } from 'vitest'
import type { WebContents } from 'electron'
import { createEventForwarder } from './event-forwarder'
import { InMemoryEventBus } from '../adapters/event-bus/in-memory-event-bus'
import { CHANNELS } from '../shared/ipc'
import type { EventDTO } from '../shared/events'
import { asTaskId } from '../domain/ids'

/** A fake WebContents recording `send` calls, with a controllable destroyed flag. */
class FakeWebContents {
  readonly sent: Array<{ channel: string; dto: EventDTO }> = []
  destroyed = false
  send(channel: string, dto: EventDTO): void {
    this.sent.push({ channel, dto })
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  /** Cast to the structural WebContents the forwarder needs. */
  as(): WebContents {
    return this as unknown as WebContents
  }
}

describe('createEventForwarder (§6.5)', () => {
  it('buffers events emitted before attach+markReady, then flushes in order on ready', () => {
    const bus = new InMemoryEventBus()
    const forwarder = createEventForwarder(bus)
    const wc = new FakeWebContents()

    // Emitted during bootstrap, before the renderer target exists.
    bus.publish({ type: 'taskStale', taskId: asTaskId('t1') })
    bus.publish({ type: 'taskDeleted', taskId: asTaskId('t2') })
    expect(wc.sent).toEqual([])

    // Attaching a target alone does not flush — the renderer isn't ready yet.
    forwarder.attach(wc.as())
    expect(wc.sent).toEqual([])

    forwarder.markReady()
    expect(wc.sent.map((s) => s.channel)).toEqual([CHANNELS.event, CHANNELS.event])
    expect(wc.sent.map((s) => s.dto.type)).toEqual(['taskStale', 'taskDeleted'])
  })

  it('flushes buffered events on attach when already ready (markReady before attach)', () => {
    const bus = new InMemoryEventBus()
    const forwarder = createEventForwarder(bus)
    const wc = new FakeWebContents()

    forwarder.markReady()
    bus.publish({ type: 'taskStale', taskId: asTaskId('t1') })
    // No target yet — still buffered.
    expect(wc.sent).toEqual([])

    forwarder.attach(wc.as())
    expect(wc.sent.map((s) => s.dto.type)).toEqual(['taskStale'])
  })

  it('forwards live events immediately once attached and ready', () => {
    const bus = new InMemoryEventBus()
    const forwarder = createEventForwarder(bus)
    const wc = new FakeWebContents()
    forwarder.attach(wc.as())
    forwarder.markReady()

    bus.publish({ type: 'activeTaskChanged', taskId: asTaskId('t1') })
    expect(wc.sent).toHaveLength(1)
    expect(wc.sent[0]).toEqual({
      channel: CHANNELS.event,
      dto: { type: 'activeTaskChanged', taskId: 't1' }
    })
  })

  it('drops sends silently when the target is destroyed', () => {
    const bus = new InMemoryEventBus()
    const forwarder = createEventForwarder(bus)
    const wc = new FakeWebContents()
    forwarder.attach(wc.as())
    forwarder.markReady()
    wc.destroyed = true

    // Must not throw, and nothing is sent to a destroyed target.
    expect(() => bus.publish({ type: 'taskStale', taskId: asTaskId('t1') })).not.toThrow()
    expect(wc.sent).toEqual([])
  })

  it('dispose() unsubscribes so later events are not forwarded', () => {
    const bus = new InMemoryEventBus()
    const forwarder = createEventForwarder(bus)
    const wc = new FakeWebContents()
    forwarder.attach(wc.as())
    forwarder.markReady()
    forwarder.dispose()

    bus.publish({ type: 'taskStale', taskId: asTaskId('t1') })
    expect(wc.sent).toEqual([])
  })
})
