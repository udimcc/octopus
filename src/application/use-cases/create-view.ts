/**
 * `createView` use case (window-view feature, DESIGN §3.7/§6.7 pattern). Mints a
 * dedicated OS window PINNED PERMANENTLY to one task — "New Window From Task" in
 * the main window's task-row context menu. At most one view per task (checked
 * via `viewForTask`).
 *
 * Order:
 *   1. Mint a window id, persist `WindowRecord{role:'view', taskId, bounds}`,
 *      publish `windowCreated` — same shape `createWindow` itself persists/
 *      publishes for a `view` role, done inline here rather than delegating to
 *      `createWindow` because `createWindow`'s `CreateWindowInput` is typed
 *      `role: 'secondary'` only (a view is never opened through that command).
 *   2. Bulk-move every session of T currently hosted in MAIN's window group
 *      (main + main's secondaries) into the new view, via `moveSessionToWindow`
 *      — called directly (NOT through the command loop's `moveSessionToWindow`
 *      dispatch), so the cross-group-move guard the loop enforces for a
 *      user-initiated drag never applies to this internal, same-feature move.
 *      T can have no sessions outside main's group yet (no view existed before
 *      now), so filtering by `windowGroupRoot(...) === MAIN_WINDOW_ID` is
 *      exhaustive over T's sessions.
 *      - T's `activeSessionId` (if among them) moves FIRST, with no `cause` —
 *        the session the user was last looking at for T is the natural one to
 *        land on on open, mirroring `createWindowWithSession`'s own "the target
 *        marks only the member sent" choice. Sending it first also means any
 *        OTHER member of ITS group rides along tagged `cause: 'groupMove'` from
 *        this very call, rather than racing a later iteration of the loop below.
 *      - Every other session of T still in main's group moves next, each sent
 *        with an explicit `cause: 'groupMove'` — so the view does not re-mark on
 *        each one (only the active session, sent above, ends up marked there).
 *        A session already moved as a groupmate of the active one is a no-op
 *        here (`moveSessionToWindow`'s idempotent same-window guard).
 *   3. Publish `viewCreated`.
 *
 * Main's `activeTaskId`/`activeSessionId` pointers are NOT touched — T leaving
 * main's group for its own window is a renderer-side empty-state concern, not an
 * application-level task switch.
 */

import type { AppDependencies } from '../dependencies'
import type { CreateViewInput, CommandResult } from '../commands'
import { MAIN_WINDOW_ID } from '../../domain/ids'
import { DEFAULT_WINDOW_BOUNDS } from './create-window'
import { moveSessionToWindow } from './move-session-to-window'
import { windowGroupRoot, viewForTask } from './window-groups'

export function createView(deps: AppDependencies, input: CreateViewInput): CommandResult {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    return { ok: false, error: `task ${input.taskId} not found` }
  }

  const windows = deps.persistence.loadWindows()
  if (viewForTask(windows, input.taskId)) {
    return { ok: false, error: `task ${input.taskId} already has a view` }
  }

  const windowId = deps.ids.newWindowId()
  const bounds = input.bounds ?? DEFAULT_WINDOW_BOUNDS

  deps.persistence.upsertWindow({
    id: windowId,
    role: 'view',
    bounds,
    createdAt: deps.clock.now(),
    taskId: input.taskId
  })
  deps.bus.publish({ type: 'windowCreated', windowId, role: 'view', bounds, taskId: input.taskId })

  // Bulk-move T's sessions out of main's group. The active session (if among
  // them) goes FIRST and without a cause, so the view marks it; everything
  // else follows tagged `groupMove` (see module doc for why the order matters).
  const toMove = task
    .sessions()
    .filter((s) => windowGroupRoot(windows, s.windowId) === MAIN_WINDOW_ID)
  const activeSessionId = task.activeSessionId
  if (activeSessionId !== undefined && toMove.some((s) => s.id === activeSessionId)) {
    moveSessionToWindow(deps, { sessionId: activeSessionId, targetWindowId: windowId })
  }
  for (const session of toMove) {
    if (session.id === activeSessionId) continue
    moveSessionToWindow(
      deps,
      { sessionId: session.id, targetWindowId: windowId },
      { cause: 'groupMove' }
    )
  }

  deps.bus.publish({ type: 'viewCreated', windowId, taskId: input.taskId })

  return { ok: true, windowId }
}
