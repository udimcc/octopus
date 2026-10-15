/**
 * Pure helpers over persisted window records resolving WINDOW-GROUP membership
 * (window-view feature). A "window group" is a root window — `main`, or a
 * task's dedicated `view` — plus the secondaries parented to it
 * (`WindowRecord.parentWindowId`). Today's main-group secondaries persist no
 * `parentWindowId` at all (legacy rows, §6.7); only a VIEW's secondaries carry
 * one, pointing at that view's id (`create-window.ts`).
 *
 * These read `deps.persistence.loadWindows()` directly — the same synchronous,
 * sub-ms source of truth `get-state.ts` already uses (DESIGN §6.6) — so callers
 * pass the already-loaded array rather than each helper re-querying it.
 */

import type { WindowId, TaskId } from '../../domain/ids'
import type { WindowRecord } from '../../ports/workspace-persistence'
import { MAIN_WINDOW_ID } from '../../domain/ids'

/**
 * Resolve `windowId`'s group ROOT: itself if it names a `view`; its
 * `parentWindowId` if it names a secondary parented to a STILL-EXISTING view;
 * `MAIN_WINDOW_ID` otherwise — which covers main itself, every one of main's
 * (parent-less) secondaries, an unknown/not-yet-persisted window id (defensive —
 * callers may pass a brand-new id ahead of its own `upsertWindow`), and a
 * secondary whose parent view has since vanished (a dangling id should never
 * outlive its view, but falls back to main rather than resolving to nothing).
 */
export function windowGroupRoot(windows: readonly WindowRecord[], windowId: WindowId): WindowId {
  const record = windows.find((w) => w.id === windowId)
  if (!record) {
    return MAIN_WINDOW_ID
  }
  if (record.role === 'view') {
    return record.id
  }
  if (record.parentWindowId !== undefined) {
    const parent = windows.find((w) => w.id === record.parentWindowId)
    if (parent?.role === 'view') {
      return parent.id
    }
  }
  return MAIN_WINDOW_ID
}

/** The task's dedicated view window, if one exists (at most one per task, enforced by `createView`). */
export function viewForTask(
  windows: readonly WindowRecord[],
  taskId: TaskId
): WindowRecord | undefined {
  return windows.find((w) => w.role === 'view' && w.taskId === taskId)
}

/** Every secondary window parented directly to `rootId` (main, or a view). */
export function secondariesOf(
  windows: readonly WindowRecord[],
  rootId: WindowId
): readonly WindowRecord[] {
  return windows.filter(
    (w) => w.role === 'secondary' && (w.parentWindowId ?? MAIN_WINDOW_ID) === rootId
  )
}

/**
 * The task `windowId`'s GROUP is pinned to, if its group root is a view —
 * `undefined` for a main-rooted window (main itself, or any of main's
 * secondaries). Resolves via `windowGroupRoot` so a view's OWN secondary pins the
 * same as its view: a secondary has no `taskId` of its own, so looking at
 * `windowId`'s own record (instead of its group root's) under-pins it, which is
 * exactly the "view secondaries aren't pinned" bug this helper fixes.
 */
export function viewTaskIdForWindow(
  windows: readonly WindowRecord[],
  windowId: WindowId
): TaskId | undefined {
  const root = windows.find((w) => w.id === windowGroupRoot(windows, windowId))
  return root?.role === 'view' ? root.taskId : undefined
}
