/**
 * `pruneStaleViews` — boot-time reconciliation (window-view feature), mirroring
 * `reconcile.ts`'s pattern: called directly on `deps` (no command loop exists
 * yet) once after `Workspace.hydrate`, before any `BrowserWindow` opens, so a
 * stale window row never gets a chance to reopen as an OS window.
 *
 * A view becomes stale when its task is gone — deleting a task normally closes
 * its view itself (`delete-task.ts`), but an older DB row (pre-dates that
 * code), a crash mid-teardown, or a manually edited DB can still leave one
 * behind. A secondary becomes ORPHANED when its `parentWindowId` names a view
 * that is itself stale, or no window row at all (any dangling parent link).
 *
 * For every window being removed, any session still persisted at that
 * `windowId` is re-homed to `MAIN_WINDOW_ID` FIRST — via `moveSessionToWindow`
 * called directly, bypassing the command loop's cross-group guard entirely
 * (same as every other internal caller) — so no session definition is ever
 * silently stranded on a window id about to vanish. No `cause` is passed: boot
 * reconciliation predates any window being open to receive a mark, and no
 * `sessionMovedToWindow` listener is live yet either.
 *
 * Each removed window gets a plain `deleteWindow` + `windowClosed` — no
 * `viewClosed` (there is no live view-aware UI to tell; `main` has not opened
 * any windows yet) and no `switchTask` (hydrate already resolved
 * `activeTaskId`; nothing here should move it).
 */

import type { AppDependencies } from '../dependencies'
import type { WindowId } from '../../domain/ids'
import { MAIN_WINDOW_ID } from '../../domain/ids'
import { moveSessionToWindow } from './move-session-to-window'

export function pruneStaleViews(deps: AppDependencies): void {
  const windows = deps.persistence.loadWindows()

  const staleViewIds = new Set<WindowId>(
    windows
      .filter(
        (w) => w.role === 'view' && (w.taskId === undefined || !deps.workspace.task(w.taskId))
      )
      .map((w) => w.id)
  )

  const orphanedSecondaryIds = windows
    .filter((w) => w.role === 'secondary' && w.parentWindowId !== undefined)
    .filter((w) => {
      const parent = windows.find((p) => p.id === w.parentWindowId)
      return staleViewIds.has(w.parentWindowId!) || !parent
    })
    .map((w) => w.id)

  const toRemove = new Set<WindowId>([...staleViewIds, ...orphanedSecondaryIds])
  if (toRemove.size === 0) {
    return
  }

  for (const task of deps.workspace.tasks()) {
    for (const session of task.sessions()) {
      if (toRemove.has(session.windowId)) {
        moveSessionToWindow(deps, { sessionId: session.id, targetWindowId: MAIN_WINDOW_ID })
      }
    }
  }

  for (const id of toRemove) {
    deps.persistence.deleteWindow(id)
    deps.bus.publish({ type: 'windowClosed', windowId: id })
  }
}
