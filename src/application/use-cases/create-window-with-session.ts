/**
 * `createWindowWithSession` use case (DESIGN §3.7, §6.7). The
 * detach-onto-empty-desktop gesture: a tab dragged off every existing window is
 * dropped on bare desktop, so a new secondary window is born already hosting it.
 *
 * Atomic by construction — one command dispatch runs both steps on the single
 * writer (§6.6), emitting `windowCreated` then `sessionMovedToWindow` in order. The
 * renderer therefore never observes an intermediate empty window that would flash
 * and then fill; `main` opens the OS window on the first event and the session
 * re-homes on the second.
 *
 * Reuses `createWindow` + `moveSessionToWindow` verbatim, so the invariants they
 * guard (secondary-only role, unchanged `taskId`/lifecycle, untouched PTY) hold
 * here too. Returns the new window id for `main` to open the OS window.
 */

import type { AppDependencies } from '../dependencies'
import type { CreateWindowWithSessionInput } from '../commands'
import type { WindowId } from '../../domain/ids'
import { createWindow } from './create-window'
import { moveSessionToWindow } from './move-session-to-window'

export function createWindowWithSession(
  deps: AppDependencies,
  input: CreateWindowWithSessionInput
): WindowId {
  const windowId = createWindow(deps, { role: 'secondary', bounds: input.bounds })
  moveSessionToWindow(deps, { sessionId: input.sessionId, targetWindowId: windowId })
  return windowId
}
