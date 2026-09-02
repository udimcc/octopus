import { describe, it, expect } from 'vitest'
import type { WebContents } from 'electron'
import {
  createWindowRegistry,
  PENDING_MAX_EVENTS,
  type ResolveSessionWindow
} from './window-registry'
import { InMemoryEventBus } from '../adapters/event-bus/in-memory-event-bus'
import { CHANNELS } from '../shared/ipc'
import type { EventDTO } from '../shared/events'
import { asTaskId, asSessionId, asWindowId } from '../domain/ids'

/** A fake WebContents recording `send` calls, with a controllable destroyed flag. */
class FakeWebContents {
  readonly sent: EventDTO[] = []
  destroyed = false
  send(channel: string, dto: EventDTO): void {
    expect(channel).toBe(CHANNELS.event)
    this.sent.push(dto)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  as(): WebContents {
    return this as unknown as WebContents
  }
}

const MAIN = asWindowId('main')
const WIN2 = asWindowId('win-2')

/** Register two ready windows (main + win-2) so routing can be observed on both. */
function twoWindows(resolve: ResolveSessionWindow): {
  bus: InMemoryEventBus
  main: FakeWebContents
  win2: FakeWebContents
} {
  const bus = new InMemoryEventBus()
  const registry = createWindowRegistry(bus, resolve)
  const main = new FakeWebContents()
  const win2 = new FakeWebContents()
  registry.register(MAIN, main.as())
  registry.register(WIN2, win2.as())
  registry.markReady(MAIN)
  registry.markReady(WIN2)
  return { bus, main, win2 }
}

describe('createWindowRegistry routing (§6.7)', () => {
  it('routes a session-scoped event (ptyData) ONLY to the window hosting the session', () => {
    // s1 lives in win-2.
    const { bus, main, win2 } = twoWindows(() => WIN2)
    bus.publish({ type: 'ptyData', sessionId: asSessionId('s1'), data: 'x' })
    expect(main.sent).toEqual([])
    expect(win2.sent).toEqual([{ type: 'ptyData', sessionId: 's1', data: 'x' }])
  })

  it('broadcasts sessionRenamed to ALL windows even though the session is hosted in one (replicated title)', () => {
    // s1 lives in win-2, but every window replicates its title, so all must be told.
    const { bus, main, win2 } = twoWindows(() => WIN2)
    bus.publish({
      type: 'sessionRenamed',
      taskId: asTaskId('t1'),
      sessionId: asSessionId('s1'),
      title: 'renamed'
    })
    expect(main.sent).toEqual([
      { type: 'sessionRenamed', taskId: 't1', sessionId: 's1', title: 'renamed' }
    ])
    expect(win2.sent).toEqual([
      { type: 'sessionRenamed', taskId: 't1', sessionId: 's1', title: 'renamed' }
    ])
  })

  it('broadcasts a session-scoped event when the session no longer resolves (e.g. sessionClosed after removal)', () => {
    // Resolver returns undefined → session already gone from the workspace.
    const { bus, main, win2 } = twoWindows(() => undefined)
    bus.publish({ type: 'sessionClosed', taskId: asTaskId('t1'), sessionId: asSessionId('s1') })
    expect(main.sent.map((d) => d.type)).toEqual(['sessionClosed'])
    expect(win2.sent.map((d) => d.type)).toEqual(['sessionClosed'])
  })

  it('routes sessionMovedToWindow to BOTH endpoints (from + to), and nowhere else', () => {
    const bus = new InMemoryEventBus()
    const registry = createWindowRegistry(bus, () => WIN2)
    const main = new FakeWebContents()
    const win2 = new FakeWebContents()
    const win3 = new FakeWebContents()
    registry.register(MAIN, main.as())
    registry.register(WIN2, win2.as())
    registry.register(asWindowId('win-3'), win3.as())
    registry.markReady(MAIN)
    registry.markReady(WIN2)
    registry.markReady(asWindowId('win-3'))

    bus.publish({
      type: 'sessionMovedToWindow',
      sessionId: asSessionId('s1'),
      taskId: asTaskId('t1'),
      fromWindowId: MAIN,
      toWindowId: WIN2
    })

    expect(main.sent.map((d) => d.type)).toEqual(['sessionMovedToWindow'])
    expect(win2.sent.map((d) => d.type)).toEqual(['sessionMovedToWindow'])
    // A third, uninvolved window is not touched.
    expect(win3.sent).toEqual([])
  })

  it('broadcasts task-level/window-lifecycle events to ALL windows', () => {
    const { bus, main, win2 } = twoWindows(() => WIN2)
    bus.publish({ type: 'activeTaskChanged', taskId: asTaskId('t1') })
    bus.publish({ type: 'windowClosed', windowId: asWindowId('win-9') })
    expect(main.sent.map((d) => d.type)).toEqual(['activeTaskChanged', 'windowClosed'])
    expect(win2.sent.map((d) => d.type)).toEqual(['activeTaskChanged', 'windowClosed'])
  })

  it('broadcasts sessionReordered (no single hosting session to pin it to)', () => {
    const { bus, main, win2 } = twoWindows(() => WIN2)
    bus.publish({
      type: 'sessionReordered',
      taskId: asTaskId('t1'),
      orderedSessionIds: [asSessionId('s1'), asSessionId('s2')]
    })
    expect(main.sent.map((d) => d.type)).toEqual(['sessionReordered'])
    expect(win2.sent.map((d) => d.type)).toEqual(['sessionReordered'])
  })

  it('buffers events for a not-yet-ready window and flushes them in order on markReady', () => {
    const bus = new InMemoryEventBus()
    const registry = createWindowRegistry(bus, () => MAIN)
    const main = new FakeWebContents()
    registry.register(MAIN, main.as())

    // Not ready yet → buffered.
    bus.publish({ type: 'activeTaskChanged', taskId: asTaskId('t1') })
    bus.publish({ type: 'taskDeleted', taskId: asTaskId('t2') })
    expect(main.sent).toEqual([])

    registry.markReady(MAIN)
    expect(main.sent.map((d) => d.type)).toEqual(['activeTaskChanged', 'taskDeleted'])
  })

  it('stops routing to an unregistered window', () => {
    const bus = new InMemoryEventBus()
    const registry = createWindowRegistry(bus, () => MAIN)
    const main = new FakeWebContents()
    registry.register(MAIN, main.as())
    registry.markReady(MAIN)
    registry.unregister(MAIN)

    bus.publish({ type: 'activeTaskChanged', taskId: asTaskId('t1') })
    expect(main.sent).toEqual([])
  })

  it('dispose() releases the bus subscription so later events route nowhere', () => {
    const bus = new InMemoryEventBus()
    const registry = createWindowRegistry(bus, () => MAIN)
    const main = new FakeWebContents()
    registry.register(MAIN, main.as())
    registry.markReady(MAIN)
    registry.dispose()

    bus.publish({ type: 'activeTaskChanged', taskId: asTaskId('t1') })
    expect(main.sent).toEqual([])
  })

  describe('sendTo (direct, non-broadcast — §9.5 notifications)', () => {
    const note = (windowLabel: string): EventDTO => ({
      type: 'sessionStateNotification',
      sessionId: `s-${windowLabel}`,
      taskName: 'T',
      sessionName: 'S'
    })

    it('sends to ONLY the target window, never the others', () => {
      const { main, win2 } = twoWindows(() => WIN2)
      const dto = note('a')
      // sendTo is on the registry; grab it via a fresh registry that shares nothing.
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const m = new FakeWebContents()
      const w = new FakeWebContents()
      registry.register(MAIN, m.as())
      registry.register(WIN2, w.as())
      registry.markReady(MAIN)
      registry.markReady(WIN2)

      registry.sendTo(WIN2, dto)
      expect(m.sent).toEqual([])
      expect(w.sent).toEqual([dto])
      // The unrelated two-window fixture is untouched (no bus publish happened).
      expect(main.sent).toEqual([])
      expect(win2.sent).toEqual([])
    })

    it('buffers for a not-ready target and flushes on markReady', () => {
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const main = new FakeWebContents()
      registry.register(MAIN, main.as())

      const dto = note('b')
      registry.sendTo(MAIN, dto) // not ready yet → buffered
      expect(main.sent).toEqual([])

      registry.markReady(MAIN)
      expect(main.sent).toEqual([dto])
    })

    it('silently drops when the target window is unknown', () => {
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const main = new FakeWebContents()
      registry.register(MAIN, main.as())
      registry.markReady(MAIN)

      expect(() => registry.sendTo(WIN2, note('c'))).not.toThrow()
      expect(main.sent).toEqual([])
    })
  })

  describe('bounded pre-hydration buffer (main-process memory, §6.7)', () => {
    it('caps the queue at PENDING_MAX_EVENTS, keeping the NEWEST events', () => {
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const main = new FakeWebContents()
      registry.register(MAIN, main.as())

      // Never marked ready: everything queues. Publish one over the cap.
      for (let i = 0; i <= PENDING_MAX_EVENTS; i++) {
        bus.publish({ type: 'ptyData', sessionId: asSessionId('s1'), data: `#${i}` })
      }
      registry.markReady(MAIN)

      expect(main.sent).toHaveLength(PENDING_MAX_EVENTS)
      // The oldest was dropped, the newest survived — on overflow, recent output wins.
      expect((main.sent[0] as { data: string }).data).toBe('#1')
      expect((main.sent[PENDING_MAX_EVENTS - 1] as { data: string }).data).toBe(
        `#${PENDING_MAX_EVENTS}`
      )
    })

    it('drops for a destroyed webContents instead of queueing forever', () => {
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const main = new FakeWebContents()
      registry.register(MAIN, main.as())
      main.destroyed = true

      // A destroyed renderer never comes back, so a queue for it could only grow.
      for (let i = 0; i < 10; i++) {
        bus.publish({ type: 'ptyData', sessionId: asSessionId('s1'), data: `#${i}` })
      }
      // Nothing queued: `markReady` (were it to arrive) has nothing to flush, and the
      // send is never attempted on the dead contents.
      main.destroyed = false
      registry.markReady(MAIN)
      expect(main.sent).toEqual([])
    })
  })
})
