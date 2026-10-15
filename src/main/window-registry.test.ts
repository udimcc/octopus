import { describe, it, expect } from 'vitest'
import type { WebContents } from 'electron'
import {
  createWindowRegistry,
  PENDING_MAX_EVENTS,
  type ResolveSessionWindow
} from './window-registry'
import { InMemoryEventBus } from '../adapters/event-bus/in-memory-event-bus'
import { CHANNELS } from '../shared/ipc'
import { OUTPUT_TAIL_MAX_BYTES } from '../shared/output-tail'
import type { EventDTO } from '../shared/events'
import { asTaskId, asSessionId, asWindowId, asTypeId } from '../domain/ids'
import { SessionLifecycle } from '../domain/lifecycle'
import { SessionState } from '../domain/state'
import type { WindowRecord } from '../ports/workspace-persistence'

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

/** Concatenate the `ptyData` payloads a window received, in order. */
function ptyOutput(sent: readonly EventDTO[]): string {
  return sent
    .filter((d) => d.type === 'ptyData')
    .map((d) => (d as Extract<EventDTO, { type: 'ptyData' }>).data)
    .join('')
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

  it('broadcasts sessionCreated to ALL windows even though the session is hosted in one (replicated store)', () => {
    // s1 lives in win-2; main must still learn of it (cycling + a later move-in).
    const { bus, main, win2 } = twoWindows(() => WIN2)
    bus.publish({
      type: 'sessionCreated',
      taskId: asTaskId('t1'),
      session: {
        id: asSessionId('s1'),
        taskId: asTaskId('t1'),
        typeId: asTypeId('terminal'),
        title: 'Terminal 1',
        config: { kind: 'terminal' },
        lifecycle: SessionLifecycle.Running,
        state: SessionState.Unknown,
        order: 0,
        createdAt: 1,
        windowId: WIN2
      }
    })
    expect(main.sent.map((d) => d.type)).toEqual(['sessionCreated'])
    expect(win2.sent.map((d) => d.type)).toEqual(['sessionCreated'])
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
        bus.publish({ type: 'taskRenamed', taskId: asTaskId('t1'), name: `#${i}` })
      }
      registry.markReady(MAIN)

      expect(main.sent).toHaveLength(PENDING_MAX_EVENTS)
      // The oldest was dropped, the newest survived — on overflow, recent events win.
      expect((main.sent[0] as { name: string }).name).toBe('#1')
      expect((main.sent[PENDING_MAX_EVENTS - 1] as { name: string }).name).toBe(
        `#${PENDING_MAX_EVENTS}`
      )
    })

    /**
     * REGRESSION (session restore after a VDI re-login): a restored session's FIRST event
     * is the daemon's whole-ring replay, and everything after it is output xterm would
     * have scrolled away. Counting events and dropping the oldest therefore threw away
     * exactly the history the queue exists to deliver. `ptyData` is now held per session
     * as a byte-bounded tail, so no volume of live output can evict the replay's head.
     */
    it('never lets live output push a session’s replayed history out of the queue', () => {
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const main = new FakeWebContents()
      registry.register(MAIN, main.as())

      bus.publish({ type: 'ptyData', sessionId: asSessionId('s1'), data: 'REPLAYED-HISTORY\n' })
      for (let i = 0; i <= PENDING_MAX_EVENTS * 2; i++) {
        bus.publish({ type: 'ptyData', sessionId: asSessionId('s1'), data: `#${i}` })
      }
      registry.markReady(MAIN)

      const output = ptyOutput(main.sent)
      expect(output).toContain('REPLAYED-HISTORY')
      expect(output).toContain(`#${PENDING_MAX_EVENTS * 2}`)
    })

    it('bounds per-session output by bytes, keeping the newest', () => {
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const main = new FakeWebContents()
      registry.register(MAIN, main.as())

      bus.publish({
        type: 'ptyData',
        sessionId: asSessionId('s1'),
        data: 'ANCIENT' + 'x'.repeat(OUTPUT_TAIL_MAX_BYTES) + 'NEWEST'
      })
      registry.markReady(MAIN)

      const output = ptyOutput(main.sent)
      expect(output).toHaveLength(OUTPUT_TAIL_MAX_BYTES)
      expect(output.endsWith('NEWEST')).toBe(true)
      expect(output.includes('ANCIENT')).toBe(false)
    })

    it('keeps each session’s output separate and in order', () => {
      const bus = new InMemoryEventBus()
      const registry = createWindowRegistry(bus, () => MAIN)
      const main = new FakeWebContents()
      registry.register(MAIN, main.as())

      bus.publish({ type: 'ptyData', sessionId: asSessionId('s1'), data: 'a1' })
      bus.publish({ type: 'ptyData', sessionId: asSessionId('s2'), data: 'b1' })
      bus.publish({ type: 'ptyData', sessionId: asSessionId('s1'), data: 'a2' })
      registry.markReady(MAIN)

      const perSession = new Map<string, string>()
      for (const dto of main.sent) {
        if (dto.type !== 'ptyData') continue
        const d = dto as { sessionId: string; data: string }
        perSession.set(d.sessionId, (perSession.get(d.sessionId) ?? '') + d.data)
      }
      expect(perSession.get('s1')).toBe('a1a2')
      expect(perSession.get('s2')).toBe('b1')
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

  describe('activeTaskChanged skips view windows (window-view feature)', () => {
    const T1 = asTaskId('t1')

    /** Minimal fields a WindowRecord test fixture needs. */
    function winRec(over: Omit<Partial<WindowRecord>, 'id'> & { id: string }): WindowRecord {
      return {
        role: 'secondary',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        createdAt: 1,
        ...over,
        id: asWindowId(over.id)
      } as WindowRecord
    }

    it('skips a VIEW window but still reaches main and a plain secondary', () => {
      const bus = new InMemoryEventBus()
      const records: WindowRecord[] = [
        winRec({ id: 'main', role: 'main' }),
        winRec({ id: 'win-2', role: 'secondary' }),
        winRec({ id: 'view-1', role: 'view', taskId: T1 })
      ]
      const registry = createWindowRegistry(
        bus,
        () => undefined,
        () => records
      )
      const main = new FakeWebContents()
      const win2 = new FakeWebContents()
      const view1 = new FakeWebContents()
      registry.register(MAIN, main.as())
      registry.register(WIN2, win2.as())
      registry.register(asWindowId('view-1'), view1.as())
      registry.markReady(MAIN)
      registry.markReady(WIN2)
      registry.markReady(asWindowId('view-1'))

      bus.publish({ type: 'activeTaskChanged', taskId: T1 })

      expect(main.sent.map((d) => d.type)).toEqual(['activeTaskChanged'])
      expect(win2.sent.map((d) => d.type)).toEqual(['activeTaskChanged'])
      expect(view1.sent).toEqual([])
    })

    it('also skips a secondary PARENTED to the view (the pin travels to the whole group)', () => {
      const bus = new InMemoryEventBus()
      const records: WindowRecord[] = [
        winRec({ id: 'main', role: 'main' }),
        winRec({ id: 'view-1', role: 'view', taskId: T1 }),
        winRec({ id: 'view-1-sec', role: 'secondary', parentWindowId: asWindowId('view-1') })
      ]
      const registry = createWindowRegistry(
        bus,
        () => undefined,
        () => records
      )
      const main = new FakeWebContents()
      const view1 = new FakeWebContents()
      const viewSec = new FakeWebContents()
      registry.register(MAIN, main.as())
      registry.register(asWindowId('view-1'), view1.as())
      registry.register(asWindowId('view-1-sec'), viewSec.as())
      registry.markReady(MAIN)
      registry.markReady(asWindowId('view-1'))
      registry.markReady(asWindowId('view-1-sec'))

      bus.publish({ type: 'activeTaskChanged', taskId: T1 })

      expect(main.sent.map((d) => d.type)).toEqual(['activeTaskChanged'])
      expect(view1.sent).toEqual([])
      expect(viewSec.sent).toEqual([])
    })

    it('every OTHER event type still reaches a view window unchanged (only activeTaskChanged is special-cased)', () => {
      const bus = new InMemoryEventBus()
      const records: WindowRecord[] = [
        winRec({ id: 'main', role: 'main' }),
        winRec({ id: 'view-1', role: 'view', taskId: T1 })
      ]
      const registry = createWindowRegistry(
        bus,
        () => undefined,
        () => records
      )
      const main = new FakeWebContents()
      const view1 = new FakeWebContents()
      registry.register(MAIN, main.as())
      registry.register(asWindowId('view-1'), view1.as())
      registry.markReady(MAIN)
      registry.markReady(asWindowId('view-1'))

      bus.publish({ type: 'taskRenamed', taskId: T1, name: 'Renamed' })
      bus.publish({ type: 'windowClosed', windowId: asWindowId('win-9') })

      expect(main.sent.map((d) => d.type)).toEqual(['taskRenamed', 'windowClosed'])
      expect(view1.sent.map((d) => d.type)).toEqual(['taskRenamed', 'windowClosed'])
    })

    it('defaults to treating every window as non-view when loadWindowRecords is omitted (back-compat)', () => {
      // No 3rd arg at all — the pre-window-view call sites keep broadcasting
      // activeTaskChanged to everyone, since `viewTaskIdForWindow([], id)` is
      // always undefined.
      const { bus, main, win2 } = twoWindows(() => WIN2)
      bus.publish({ type: 'activeTaskChanged', taskId: T1 })
      expect(main.sent.map((d) => d.type)).toEqual(['activeTaskChanged'])
      expect(win2.sent.map((d) => d.type)).toEqual(['activeTaskChanged'])
    })
  })
})
