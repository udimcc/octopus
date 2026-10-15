# Window View - Design

**Feature**: Allow users to pop a task into its own dedicated window (a "view"), pinned to that task permanently. Each view can have its own secondary windows. The main window retains full task switching; views are independent.

## Architecture

### Approach: New Window Role

Extend `WindowRecord.role` from `'main' | 'secondary'` to `'main' | 'secondary' | 'view'`. A view window is pinned to a `taskId` stored on the `WindowRecord`. Its secondaries are linked via a `parentWindowId` field.

**Data model extension:**
- `WindowRecord` gains `taskId?: TaskId` (set only for `role: 'view'`; null for main/secondary)
- `WindowRecord` gains `parentWindowId?: WindowId` — links a secondary to its parent window (main or a view). Today's secondaries implicitly belong to main; this makes the link explicit.
- New invariant: at most one view window per task (enforced in `createView` use case)

**Event routing changes:**
- `activeTaskChanged` is NOT broadcast to view windows — they are pinned to their task
- All other events (session-scoped, task-level) route as today; view windows still receive `sessionCreated`, `taskRenamed`, `sessionStateChanged`, etc.

**Session ownership lifecycle:**
- **Create view:** all sessions with `taskId === T` in the main window group (main + main's secondaries) are bulk-moved to the view window. User is prompted if sessions exist.
- **Close view:** reverse — all sessions in the view group (view + its secondaries) bulk-move to main. Main auto-switches to the returning task. View's secondaries are closed first.
- **Session walk:** `Ctrl+Shift+Arrow` scoped to the view group (view + its secondaries), never crossing into main's windows or other views.
- **No cross-view drag:** sessions cannot be dragged between different view groups.

**UI model:**
- View window layout: progress panel (all tasks grayed out, viewed task selected) + session area + view indicator badge
- Main window: task rows with views show "Viewing in window" badge (informational only). "+ New Session" grayed when active task has a view. Clicking a viewed task shows an empty state.
- Only the main window can create views (right-click context menu on task row)
- One view per task
- Closing the main window quits everything (views included)
- Single-instance: re-launching focuses the main window

## Implementation Overview

**By layer (following hexagonal architecture):**

- **Domain/Ports:** `WindowRecord` type extended with `taskId` and `parentWindowId`. No new domain aggregates — views are a window-level concern, not a domain entity.
- **Shared/IPC:** New `view:create`/`view:close` channels. `OctopusAPI.views` group. `viewCreated`/`viewClosed` events. Extended `WindowDTO`/`WindowedWorkspaceStateDTO`.
- **Persistence:** Schema migration adds `task_id`/`parent_window_id` columns to `windows` table.
- **Application:** Three new use cases (`createView`, `closeView`, `createViewSecondary`). Modified `openSession` refuses session creation from non-view windows for viewed tasks. Modified `createWindow`/`closeWindow` support parent linkage.
- **Main process:** `WindowRegistry` gains view-awareness: `activeTaskChanged` skips view windows. Window lifecycle handles view creation/close/cascade. Single-instance lock added. Boot restores views (discards stale ones).
- **Renderer:** Third layout (`ViewWindowApp`). Store extended with `viewTaskId`. Session walk scoped to view group. Context menu on task rows. Confirmation dialog on view creation.

## Testing

**Scope:** Domain invariants (one-view-per-task), use cases (create/close/session-move), persistence (migration), event routing (view-aware), renderer store (reducers, selectors, scoped walk).

**Existing test changes:**
- Store reducer tests: verify view windows ignore `activeTaskChanged`
- `WindowRegistry` routing tests: verify `activeTaskChanged` skip for views
- `closeWindow` tests: verify cascade close of view secondaries

**New tests:**
- `createView` use case: invariant enforcement, bulk-move, events
- `closeView` use case: session return, auto-switch, secondary cascade
- `openSession` refusal for viewed tasks from non-view windows
- Schema migration: columns added, existing data preserved
- Store: `viewCreated`/`viewClosed` reducers, `isViewedTask` selector
- Session walk: scoped within view group
- Boot restoration: stale view discarded

**Edge cases:**
- Creating a view for a task with sessions in main's secondary windows (all should move)
- Closing a view while its secondary is mid-close
- Deleting a task that has a view (view closes gracefully)
- Restoring a view for a deleted task (silently discard)
- Session walk at view group boundary (wraps within group, never crosses to main)
