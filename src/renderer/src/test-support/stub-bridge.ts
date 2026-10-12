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
import type { CommandAck, WindowedWorkspaceStateDTO } from '../../../shared/dto'

export interface StubBridge {
  readonly api: OctopusAPI
  /** Push an event to every registered `onEvent` listener. */
  readonly emit: (event: EventDTO) => void
}

const EMPTY_STATE: WindowedWorkspaceStateDTO = {
  tasks: [],
  activeTaskId: undefined,
  sessionTypes: [],
  settings: {
    worktree: { location: '' },
    terminal: {},
    defaultSessionTypeId: 'terminal',
    groupTasksByRepo: true
  },
  version: 1,
  // V1.5: each renderer is stamped with its window identity + the window list.
  thisWindowId: 'main',
  thisWindowRole: 'main',
  windows: [
    { id: 'main', role: 'main', bounds: { x: 0, y: 0, width: 1280, height: 800 }, createdAt: 0 }
  ]
}

/**
 * Build a stub bridge. `ackImpl` (default `{ ok: true }`) backs every command mock
 * so a test can assert calls; pass a custom impl to exercise failure/dirty gates.
 * `state` seeds `app.getState`. `windowId` seeds the synchronous `app.getWindowId`.
 */
export function makeStubBridge(options?: {
  ack?: () => CommandAck | Promise<CommandAck>
  state?: WindowedWorkspaceStateDTO
  windowId?: string
}): StubBridge {
  const listeners = new Set<(event: EventDTO) => void>()
  const ackImpl = options?.ack ?? (() => ({ ok: true }) as CommandAck)
  // Always resolve to a Promise so callers can `.then(...)` even when a test's
  // custom ack returns a plain object.
  const ack = vi.fn(() => Promise.resolve(ackImpl()))
  const state = options?.state ?? EMPTY_STATE
  const windowId = options?.windowId ?? state.thisWindowId

  const api: OctopusAPI = {
    ping: vi.fn().mockResolvedValue('pong'),
    tasks: { create: ack, delete: ack, rename: ack, reorder: ack, switch: ack },
    sessions: {
      create: ack,
      close: ack,
      switch: ack,
      rename: ack,
      reorder: ack,
      move: ack,
      cwd: vi.fn().mockResolvedValue(null),
      refreshState: vi.fn(),
      markSeen: vi.fn(),
      focus: vi.fn()
    },
    windows: {
      create: ack,
      close: ack,
      createWithSession: ack,
      windowAtPoint: vi.fn().mockResolvedValue(null)
    },
    pty: { write: vi.fn(), resize: vi.fn() },
    app: {
      getState: vi.fn().mockResolvedValue(state),
      updateSettings: ack,
      getWindowId: vi.fn(() => windowId),
      getVersion: vi.fn().mockResolvedValue('0.0.0-test')
    },
    dialog: { pickDirectory: vi.fn().mockResolvedValue(undefined) },
    clipboard: {
      read: vi.fn().mockResolvedValue(''),
      write: vi.fn().mockResolvedValue(undefined)
    },
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
