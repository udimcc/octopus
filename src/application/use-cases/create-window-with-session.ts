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
 * here too — including `moveSessionToWindow`'s group handling (DESIGN §5.7): if
 * `input.sessionId` is a group member, its WHOLE group is detached into the new
 * window together, and only `input.sessionId` is marked there (groupmates ride
 * along with `cause: 'groupMove'`). A lone session detaches alone, unchanged.
 *
 * **Window-group linkage (window-view feature).** The new secondary's
 * `parentWindowId` is the detached session's CURRENT window-group root
 * (`windowGroupRoot`, resolved before anything is created): detaching a tab out
 * of a view's own window or one of its secondaries creates a new secondary OF
 * THAT VIEW, never main's — the detach gesture never moves a session across a
 * window-group boundary, it just gives it a new sibling window in the SAME
 * group. Detaching from main (or any of main's secondaries) behaves exactly as
 * before (no `parentWindowId`).
 *
 * Also marks `input.sessionId` as its task's persisted focused session (review
 * IMP2), mirroring `focus-session.ts`'s own `setActiveSession` + `upsertTask`
 * write. This does NOT make the new window show the detached session — the new
 * window is created HIDDEN (`main/window.ts`, shown on `ready-to-show`), so the
 * still-focused SOURCE window keeps reporting ITS OWN mark via `sessions.focus`
 * in the meantime and overwrites this write before the new window ever hydrates.
 * The new window's correct mark is carried instead by `initialMarks`, a one-shot
 * `windowId → {taskId, sessionId}` registry `main/ipc-handlers.ts` populates right
 * after this use case returns (keyed off the returned `windowId`) and hands back
 * in that window's own `getState` reply (`WindowedWorkspaceStateDTO.initialMark`)
 * — see `ipc-handlers.ts`'s `windowCreateWithSession` handler. This write's only
 * remaining value is cross-RESTART: if the app quits and relaunches, the detached
 * session is still the task's persisted `activeSessionId`, so whichever window
 * hosts it falls back to marking it (`store.ts`'s `pickMark`) absent any
 * `initialMark` (which doesn't survive a restart, only a reload).
 *
 * Returns the new window id for `main` to open the OS window.
 */

import type { AppDependencies } from '../dependencies'
import type { CreateWindowWithSessionInput } from '../commands'
import type { WindowId } from '../../domain/ids'
import { createWindow } from './create-window'
import { moveSessionToWindow } from './move-session-to-window'
import { locateSession } from './locate-session'
import { windowGroupRoot } from './window-groups'
import { InvariantViolationError } from '../../domain/errors'

export function createWindowWithSession(
  deps: AppDependencies,
  input: CreateWindowWithSessionInput
): WindowId {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    throw new InvariantViolationError(`session ${input.sessionId} not found`)
  }
  const parentWindowId = windowGroupRoot(deps.persistence.loadWindows(), located.session.windowId)

  const windowId = createWindow(deps, {
    role: 'secondary',
    bounds: input.bounds,
    parentWindowId
  })
  moveSessionToWindow(deps, { sessionId: input.sessionId, targetWindowId: windowId })

  located.task.setActiveSession(input.sessionId)
  deps.persistence.upsertTask(located.task.toSnapshot(deps.aggregator))

  return windowId
}
