/**
 * Shared test helper: a controllable stub of the preload bridge
 * (`window.octopusAPI`) for renderer component tests. There is no Electron in the
 * jsdom test env, so tests install this and drive the app the way the backend
 * would — resolving command acks and pushing events over `onEvent`.
 *
 * Mirrors the ad-hoc stub in `NewTaskModal.test.tsx`/`App.test.tsx`, centralized so
 * the many M6 component tests share one definition instead of copy-pasting it.
 */

import { vi } from 'vitest'
import type { OctopusAPI } from '../../../shared/ipc'
import type { EventDTO } from '../../../shared/events'
import type { CommandAck, WorkspaceStateDTO } from '../../../shared/dto'

export interface StubBridge {
  readonly api: OctopusAPI
  /** Push an event to every registered `onEvent` listener. */
  readonly emit: (event: EventDTO) => void
}

const EMPTY_STATE: WorkspaceStateDTO = {
  tasks: [],
  activeTaskId: undefined,
  sessionTypes: [],
  settings: {
    worktree: { location: '' },
    terminal: {},
    defaultSessionTypeId: 'terminal'
  },
  version: 1
}

/**
 * Build a stub bridge. `ackImpl` (default `{ ok: true }`) backs every command mock
 * so a test can assert calls; pass a custom impl to exercise failure/dirty gates.
 * `state` seeds `app.getState`.
 */
export function makeStubBridge(options?: {
  ack?: () => CommandAck | Promise<CommandAck>
  state?: WorkspaceStateDTO
}): StubBridge {
  const listeners = new Set<(event: EventDTO) => void>()
  const ackImpl = options?.ack ?? (() => ({ ok: true }) as CommandAck)
  // Always resolve to a Promise so callers can `.then(...)` even when a test's
  // custom ack returns a plain object.
  const ack = vi.fn(() => Promise.resolve(ackImpl()))
  const state = options?.state ?? EMPTY_STATE

  const api: OctopusAPI = {
    ping: vi.fn().mockResolvedValue('pong'),
    tasks: { create: ack, delete: ack, rename: ack, reorder: ack, switch: ack },
    sessions: { create: ack, close: ack, rename: ack, reorder: ack },
    pty: { write: vi.fn(), resize: vi.fn() },
    app: { getState: vi.fn().mockResolvedValue(state), updateSettings: ack },
    dialog: { pickDirectory: vi.fn().mockResolvedValue(undefined) },
    onEvent: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    }
  }

  return {
    api,
    emit: (event) => {
      for (const l of listeners) l(event)
    }
  }
}

/** Install a stub bridge on `window.octopusAPI` and return it. */
export function installStubBridge(options?: Parameters<typeof makeStubBridge>[0]): StubBridge {
  const bridge = makeStubBridge(options)
  window.octopusAPI = bridge.api
  return bridge
}
