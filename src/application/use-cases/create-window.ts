/**
 * `createWindow` use case (DESIGN §3.7, §6.7). Opens a new SECONDARY window
 * (session-only; the single main window that owns the progress panel is created at
 * boot, never here — nor is a `view` window, minted only by `createView`). A
 * window is a presentation + persistence concept, not a domain aggregate — so
 * this use case touches no `Workspace` state: it mints an id, persists a
 * `WindowRecord`, and emits `windowCreated`.
 *
 * `main` reads the returned `windowId` to open the OS `BrowserWindow` for it, and
 * the registry (subscribed to `windowCreated`) begins routing that window's events.
 * `bounds` seeds the OS placement (e.g. a detached-tab drop point); when omitted a
 * default size is persisted and the OS chooses the position.
 *
 * **Window-group linkage (window-view feature).** `input.parentWindowId` — the
 * window the request came FROM — is normalized to its group ROOT via
 * `windowGroupRoot`. Only when that root is a VIEW is `parentWindowId` actually
 * persisted/published (set to the view's id); a request from main or any of
 * main's own secondaries resolves to `MAIN_WINDOW_ID`, which is NOT persisted —
 * so a plain secondary's row/event is byte-for-byte what it was before this
 * feature (no `parentWindowId` key at all), and `windowGroupRoot` reading it back
 * later still falls through to `MAIN_WINDOW_ID` by its own documented default.
 */

import type { AppDependencies } from '../dependencies'
import type { CreateWindowInput } from '../commands'
import { MAIN_WINDOW_ID, type WindowId } from '../../domain/ids'
import { windowGroupRoot } from './window-groups'

/** Fallback geometry when a create carries no explicit bounds (§6.7). */
export const DEFAULT_WINDOW_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1280, height: 800 })

export function createWindow(deps: AppDependencies, input: CreateWindowInput): WindowId {
  const windowId = deps.ids.newWindowId()
  const bounds = input.bounds ?? DEFAULT_WINDOW_BOUNDS

  const root =
    input.parentWindowId !== undefined
      ? windowGroupRoot(deps.persistence.loadWindows(), input.parentWindowId)
      : MAIN_WINDOW_ID
  const parentWindowId = root !== MAIN_WINDOW_ID ? root : undefined

  deps.persistence.upsertWindow({
    id: windowId,
    role: input.role,
    bounds,
    createdAt: deps.clock.now(),
    ...(parentWindowId !== undefined ? { parentWindowId } : {})
  })
  deps.bus.publish({
    type: 'windowCreated',
    windowId,
    role: input.role,
    bounds,
    ...(parentWindowId !== undefined ? { parentWindowId } : {})
  })

  return windowId
}
