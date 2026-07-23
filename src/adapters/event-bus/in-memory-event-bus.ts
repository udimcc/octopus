/**
 * In-process `EventBus` (DESIGN §6.6). Synchronous fan-out to every subscriber:
 * the application publishes a `DomainEvent`, and the main-process forwarder (the
 * sole V1 subscriber) turns it into an IPC message. Synchronous delivery keeps
 * ordering deterministic and testable — publish returns only after every handler
 * has run.
 *
 * A handler that throws must not poison the bus for the others, so each is called
 * in a try/catch; a thrown handler error is reported to `console.error` and
 * swallowed (an event subscriber failing is never fatal to a domain mutation).
 * Subscriptions taken during a publish do not receive the in-flight event (the
 * handler list is snapshotted per publish).
 */

import type { DomainEvent, EventBus, EventHandler, Unsubscribe } from '../../ports/event-bus'

export class InMemoryEventBus implements EventBus {
  private handlers = new Set<EventHandler>()

  publish(event: DomainEvent): void {
    // Snapshot so a handler that (un)subscribes mid-dispatch can't mutate the
    // set we're iterating.
    for (const handler of [...this.handlers]) {
      try {
        handler(event)
      } catch (err) {
        console.error('[octopus] event handler threw', err)
      }
    }
  }

  subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }
}
