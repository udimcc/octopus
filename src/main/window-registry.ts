/**
 * Multi-window event router (DESIGN §6.7). Replaces the single-target
 * `EventForwarder` (§6.5): instead of one `webContents`, it holds a
 * `Map<WindowId, WindowEntry>` and, from ONE bus subscription, routes each mapped
 * `EventDTO` to the right window(s) by kind:
 *
 *   - **`ptyData` + session-scoped events** (`sessionCreated/Exited/Closed/Renamed/
 *     Reordered`) → ONLY the window hosting that session. The host is resolved via
 *     the injected `resolveSessionWindow(sessionId)` (a workspace lookup of
 *     `session.windowId`). If the session can't be resolved — it was already
 *     removed from its task before the event was published, as `sessionClosed`
 *     is — we BROADCAST instead of dropping, so the one window that still shows the
 *     tab always gets the event (harmless to windows that never had it).
 *   - **`sessionMovedToWindow`** → BOTH endpoints (`fromWindowId` + `toWindowId`),
 *     so the source unmounts the pane and the target mounts it in one cycle.
 *   - **everything else** (task-level, `activeTaskChanged`, script/error, window
 *     lifecycle, dormant V2 state) → ALL windows.
 *
 * Per-window readiness mirrors the old forwarder: events published before a
 * window's renderer has hydrated (its `getState`) are buffered per entry and
 * flushed on `markReady(windowId)`. A destroyed `webContents` silently drops.
 *
 * The registry is transport-agnostic in spirit (§6.5): the routing decisions are
 * pure functions of the event + the window map, so the V2 socket daemon can reuse
 * them by swapping `webContents.send` for a socket write.
 */

import type { WebContents } from 'electron'
import type { EventBus, DomainEvent, Unsubscribe } from '../ports/event-bus'
import type { EventDTO } from '../shared/events'
import type { WindowId } from '../domain/ids'
import { CHANNELS } from '../shared/ipc'
import { toEventDTO } from './dto-mappers'

interface WindowEntry {
  readonly webContents: WebContents
  ready: boolean
  readonly pending: EventDTO[]
}

/**
 * Resolve which window currently hosts a session (its `session.windowId`), or
 * `undefined` if the session no longer exists in the workspace. Injected by the
 * composition root as a closure over the live `Workspace` so the registry itself
 * stays free of domain-aggregate traversal.
 */
export type ResolveSessionWindow = (sessionId: string) => WindowId | undefined

export interface WindowRegistry {
  /** Attach a window's `webContents` under its id (called at window creation). */
  register(windowId: WindowId, webContents: WebContents): void
  /** Detach a window (on close); buffered events for it are discarded. */
  unregister(windowId: WindowId): void
  /** Mark a window's renderer ready (its `getState` landed); flush its buffer. */
  markReady(windowId: WindowId): void
  /**
   * Send an event to ONE window directly (not via the bus), buffering it if that
   * window isn't ready yet and dropping if it's unknown/destroyed. Used for events
   * that must NOT broadcast — e.g. the active-window status-change notification
   * (§9.5) the composition root targets after resolving the focused window.
   */
  sendTo(windowId: WindowId, dto: EventDTO): void
  /**
   * Send an event to EVERY window directly (not via the bus), buffering per window as
   * needed. Used for a main-synthesized broadcast that has no domain event to route —
   * e.g. the `sessionSeen` ready-for-review clear (§9.5), relayed from the window that
   * watched a turn finish in place to all the others.
   */
  broadcast(dto: EventDTO): void
  /** Stop routing and release the bus subscription (on quit). */
  dispose(): void
}

/** Session-scoped events routed only to the hosting window (§6.7). */
const SESSION_SCOPED: ReadonlySet<EventDTO['type']> = new Set([
  'ptyData',
  'sessionCreated',
  'sessionExited',
  'sessionClosed',
  'sessionRenamed',
  'sessionReordered'
] as const)

export function createWindowRegistry(
  bus: EventBus,
  resolveSessionWindow: ResolveSessionWindow
): WindowRegistry {
  const windows = new Map<WindowId, WindowEntry>()

  const sendTo = (entry: WindowEntry, dto: EventDTO): void => {
    if (!entry.ready || entry.webContents.isDestroyed()) {
      entry.pending.push(dto)
      return
    }
    entry.webContents.send(CHANNELS.event, dto)
  }

  const sendToWindow = (windowId: WindowId, dto: EventDTO): void => {
    const entry = windows.get(windowId)
    if (entry) {
      sendTo(entry, dto)
    }
  }

  const broadcast = (dto: EventDTO): void => {
    for (const entry of windows.values()) {
      sendTo(entry, dto)
    }
  }

  /**
   * Pull the routing session id off a session-scoped event. Every member of
   * SESSION_SCOPED carries a `sessionId` EXCEPT `sessionReordered`, which is
   * task-scoped in shape (a list of ids) — it is routed by its `taskId`'s… no:
   * reorder affects a whole tab bar, so we treat it as hosting-window-scoped via
   * the first session in the list. Simpler and correct: fall back to broadcast
   * when we can't pin a single session (below).
   */
  const routeSessionScoped = (dto: EventDTO): void => {
    // Discriminate to read the id without a cast; `sessionReordered` has no single
    // sessionId, so it broadcasts (a reordered bar lives in exactly one window, and
    // other windows ignore a task list they don't render its sessions for).
    if (dto.type === 'sessionReordered' || !('sessionId' in dto) || dto.sessionId === undefined) {
      broadcast(dto)
      return
    }
    const windowId = resolveSessionWindow(dto.sessionId)
    if (windowId === undefined) {
      // Session already gone from the workspace (e.g. `sessionClosed`, published
      // after removal). Broadcast so the window that still shows the tab gets it.
      broadcast(dto)
      return
    }
    sendToWindow(windowId, dto)
  }

  const route = (event: DomainEvent): void => {
    const dto = toEventDTO(event)

    // Both endpoints re-render: source unmounts the pane, target mounts it. Read
    // the branded ids off the domain `event` (typed WindowId), not the wire dto.
    if (event.type === 'sessionMovedToWindow') {
      sendToWindow(event.fromWindowId, dto)
      sendToWindow(event.toWindowId, dto)
      return
    }

    if (SESSION_SCOPED.has(dto.type)) {
      routeSessionScoped(dto)
      return
    }

    broadcast(dto)
  }

  const unsubscribe: Unsubscribe = bus.subscribe(route)

  return {
    register(windowId: WindowId, webContents: WebContents): void {
      windows.set(windowId, { webContents, ready: false, pending: [] })
    },
    unregister(windowId: WindowId): void {
      windows.delete(windowId)
    },
    markReady(windowId: WindowId): void {
      const entry = windows.get(windowId)
      if (!entry) {
        return
      }
      entry.ready = true
      if (entry.webContents.isDestroyed()) {
        entry.pending.length = 0
        return
      }
      for (const dto of entry.pending) {
        entry.webContents.send(CHANNELS.event, dto)
      }
      entry.pending.length = 0
    },
    sendTo(windowId: WindowId, dto: EventDTO): void {
      sendToWindow(windowId, dto)
    },
    broadcast(dto: EventDTO): void {
      broadcast(dto)
    },
    dispose(): void {
      unsubscribe()
      windows.clear()
    }
  }
}
