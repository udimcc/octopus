/**
 * Event forwarder (DESIGN §6.5). Bridges the in-process `EventBus` to the renderer:
 * subscribes once, maps each `DomainEvent` to its wire `EventDTO`, and pushes it
 * over the single `app:event` channel via `webContents.send`. Using `send` (not a
 * `handle` reply) means high-frequency `ptyData` never head-of-line-blocks a
 * command ack (§6.5); the renderer routes `ptyData` straight to the terminal,
 * bypassing the store (§5.2).
 *
 * The forwarder is created before the window's contents finish loading, so events
 * emitted during startup (e.g. reconciliation `taskStale`) are buffered here until
 * the renderer signals readiness, then flushed in order. Once the target
 * `webContents` is destroyed, sends are dropped silently.
 */

import type { WebContents } from 'electron'
import type { EventBus, Unsubscribe } from '../ports/event-bus'
import type { EventDTO } from '../shared/events'
import { CHANNELS } from '../shared/ipc'
import { toEventDTO } from './dto-mappers'

export interface EventForwarder {
  /** Attach the renderer target; flushes any events buffered before attach. */
  attach(webContents: WebContents): void
  /** Mark the renderer ready to receive (after its `getState` hydration). */
  markReady(): void
  /** Stop forwarding and release the bus subscription. */
  dispose(): void
}

/**
 * Subscribe to the bus and forward mapped events to the (later-attached) renderer.
 * Events published before `attach`+`markReady` are queued so nothing emitted
 * during bootstrap is lost.
 */
export function createEventForwarder(bus: EventBus): EventForwarder {
  let target: WebContents | undefined
  let ready = false
  const pending: EventDTO[] = []

  const send = (dto: EventDTO): void => {
    if (!ready || !target || target.isDestroyed()) {
      pending.push(dto)
      return
    }
    target.send(CHANNELS.event, dto)
  }

  const flush = (): void => {
    if (!ready || !target || target.isDestroyed()) {
      return
    }
    for (const dto of pending) {
      target.send(CHANNELS.event, dto)
    }
    pending.length = 0
  }

  const unsubscribe: Unsubscribe = bus.subscribe((event) => {
    send(toEventDTO(event))
  })

  return {
    attach(webContents: WebContents): void {
      target = webContents
      flush()
    },
    markReady(): void {
      ready = true
      flush()
    },
    dispose(): void {
      unsubscribe()
      target = undefined
      pending.length = 0
    }
  }
}
