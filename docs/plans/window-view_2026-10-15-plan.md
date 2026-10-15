# Window View - Plan

**Feature**: Dedicated per-task windows (views) — right-click a task to pop it into its own window, pinned permanently. Sessions migrate between main and views on create/close.
**Design**: `docs/plans/window-view_2026-10-15-design.md`

## Wave 1 (parallel)
### [x] Subject 1: Domain + Shared contract — `src/ports/workspace-persistence.ts`, `src/shared/dto.ts`, `src/shared/events.ts`, `src/shared/ipc.ts`

- [x] Extend `WindowRecord.role` type to `'main' | 'secondary' | 'view'` in `src/ports/workspace-persistence.ts`
- [x] Add `taskId?: TaskId` and `parentWindowId?: WindowId` fields to `WindowRecord`
- [x] Add `WindowRole` type alias in `src/shared/dto.ts`; extend `WindowDTO` with `taskId?`/`parentWindowId?`
- [x] Add `CreateViewInput { taskId }` and `CloseViewInput { windowId }` to `src/shared/dto.ts`
- [x] Extend `WindowedWorkspaceStateDTO` with `viewTaskId?: string` (populated for view windows)
- [x] Add `viewCreated { windowId, taskId, role }` and `viewClosed { windowId, taskId }` event types to `src/shared/events.ts`
- [x] Add `view:create`/`view:close` channels to `CHANNELS` in `src/shared/ipc.ts`
- [x] Add `views: { create, close }` group to `OctopusAPI` in `src/shared/ipc.ts`

### [x] Subject 2: Persistence (schema migration) — `src/adapters/persistence/schema.ts`, `src/adapters/persistence/sqlite-store.ts`, `src/adapters/persistence/mappers.ts`

- [x] Bump `SCHEMA_VERSION`; add migration entry adding `task_id TEXT` and `parent_window_id TEXT` columns to `windows` table (guarded `ALTER TABLE` pattern, matching v3→4)
- [x] Update `SCHEMA_STATEMENTS` DDL with the new columns
- [x] Update `SqliteStore.upsertWindow` to write `task_id`/`parent_window_id`
- [x] Update `SqliteStore.loadWindows` to read the new columns
- [x] Update row mappers: `windowToRow`/`rowToWindowRecord` with the new fields

## Wave 2 (depends on Wave 1)
### [x] Subject 3: Application layer — use cases + commands — `src/application/commands.ts`, `src/application/command-loop.ts`, `src/application/use-cases/`, `src/application/queries/get-state.ts`

- [x] Add `createView` and `closeView` commands to `commands.ts`
- [x] Add command-loop cases for `createView`/`closeView` in `command-loop.ts`
- [x] New `create-view.ts` use case: validate no existing view for the task, generate `WindowId`, persist `WindowRecord(role:'view', taskId)`, bulk-move sessions from main group (sessions where `taskId === T` and `windowId` ∈ {main, main's secondaries}) to the new view, emit `viewCreated`
- [x] New `close-view.ts` use case: close the view's secondary windows first (reuse `closeWindow` with `disposition: 'move-to-main'` targeting the view), bulk-move remaining sessions to main, switch main to the task via `workspace.setActiveTask`, delete the window record, emit `viewClosed`
- [x] Modify `create-window.ts` to accept `parentWindowId` for creating secondaries of a view
- [x] Modify `close-window.ts`: when closing a secondary with `parentWindowId !== MAIN_WINDOW_ID`, move sessions to the parent view window (not main)
- [x] Modify `open-session.ts`: refuse session creation when calling window is not in the view group for a viewed task
- [x] Update `get-state.ts` to include `viewTaskId` for view windows (look up the window record's `taskId`)

### [x] Subject 4: Main process — window registry + lifecycle — `src/main/window-registry.ts`, `src/main/window.ts`, `src/main/ipc-handlers.ts`, `src/main/index.ts`, `src/main/composition-root.ts`

- [x] Extend `WindowRegistry`: inject a `resolveWindowViewTaskId(windowId) → TaskId | undefined` callback; in the `route` function, when event is `activeTaskChanged`, skip windows where `resolveWindowViewTaskId` returns a `TaskId` (view windows have a fixed task)
- [x] Extend `createWindow` in `window.ts` to handle `role: 'view'` — similar to secondary but without the session-less dialog; close cascade closes secondaries first
- [x] Add `ipc-handlers.ts` entries for `view:create`/`view:close` channels
- [x] Modify `index.ts` boot sequence: after restoring secondary windows, restore view windows (skip if task not found in loaded tasks), then restore view secondaries. Order: main → views → all secondaries
- [x] Add `requestSingleInstanceLock` in `index.ts`; on `second-instance`, focus the main window
- [x] Modify composition root: wire `resolveWindowViewTaskId`; add view window records to `windowIds` map; subscribe to `viewCreated`/`viewClosed` events for OS window lifecycle
- [x] Handle `taskDeleted` for tasks with views: close the view (reuse `closeView` use case)

## Wave 3 (depends on Wave 2)
### [x] Subject 5: Preload + renderer store — `src/preload/index.ts`, `src/renderer/src/store/store.ts`

- [x] Implement `views.create(input)` and `views.close(input)` in `src/preload/index.ts` bridge
- [x] Add `viewTaskId?: string` to `StoreData`; hydrate from `WindowedWorkspaceStateDTO.viewTaskId`
- [x] Add `reduceEvent` cases for `viewCreated`/`viewClosed`: update `windows` list in store; if this is main and its active task was the viewed one, clear sessions display
- [x] Add `isViewedTask(taskId)` selector: checks whether any window in `data.windows` has `role === 'view'` and `taskId === the given taskId`
- [x] Modify session walk (`nextSession`/`prevSession` in `useKeyboardShortcuts`): scope to sessions in the current view group (windows sharing the same parent), not all windows
- [x] In view windows: ignore `activeTaskChanged` events in the store reducer (when `viewTaskId` is set, keep `activeTaskId` fixed to `viewTaskId`)
- [x] Suppress cross-view DnD: `SessionTabBar` detach gesture checks `parentWindowId` compatibility before allowing a move

### [x] Subject 6: Renderer UI components — `src/renderer/src/App.tsx`, `src/renderer/src/components/`

- [x] Add `ViewWindowApp` component: progress panel (all tasks grayed out except the viewed one) + `TaskWorkspace` filtered to the view's task + a view indicator badge
- [x] Modify `App.tsx`: branch on three roles (`main`/`secondary`/`view`) instead of two
- [x] Add context menu to task rows in `ProgressPanel` / `TaskListItem`: right-click → "New Window From Task" (disabled when view already exists for this task)
- [x] Add "Viewing in window" badge on `TaskListItem` when `isViewedTask(taskId)` returns true (informational, not clickable)
- [x] Gray out "+ New Session" button in main's `SessionTabBar` when `isViewedTask(activeTaskId)` returns true
- [x] Show empty state in `TaskWorkspace` when main switches to a viewed task: "This task is shown in its own window"
- [x] Add confirmation dialog when creating a view and the task has existing sessions: "Sessions will be moved to the new window"
- [x] Set view window title to include task name + "[View]" indicator (via Electron `BrowserWindow.setTitle` in main or document.title in renderer)

## Testing

- [x] Unit: schema migration — new `task_id`/`parent_window_id` columns added correctly, existing data preserved, guarded idempotent
- [x] Unit: `createView` use case — one-view-per-task invariant rejected, session bulk-move from main + main's secondaries, `viewCreated` event emitted, `WindowRecord` persisted with correct role/taskId
- [x] Unit: `closeView` use case — sessions return to main, main auto-switches to returning task, view secondaries closed, `viewClosed` event emitted
- [x] Unit: `openSession` refusal — session creation refused when calling window is not in the view group for a viewed task
- [x] Unit: `WindowRegistry` routing — `activeTaskChanged` skips view windows, all other events still reach views
- [x] Unit: store `reduceEvent` for `viewCreated`/`viewClosed` events
- [x] Unit: `isViewedTask` selector accuracy
- [x] Unit: session walk scoped to view group (stays within view + its secondaries, wraps at boundary)
- [x] Unit: boot restoration — view window for missing task silently discarded, view for existing task restored
- [x] Unit: `closeWindow` for view secondary moves sessions to view (not main)
- [ ] Integration (manual): full view lifecycle, multi-monitor, app restart with views, task deletion with open view

## Acceptance Criteria
- Right-clicking a task in the progress panel shows "New Window From Task"; clicking it opens a view window pinned to that task
- The view window shows the progress panel with all tasks grayed out and the viewed task selected
- Sessions from the main window for that task move to the view on creation
- Closing the view moves sessions back and main auto-switches to the task
- Only one view per task; the context menu item is disabled for tasks that already have a view
- Views persist across app restarts; stale views are silently discarded
- Session walk (Ctrl+Shift+Arrow) stays within the view group
- No cross-view drag and drop
- Main shows "Viewing in window" badge on viewed tasks
- Main's "+ New Session" is grayed out for viewed tasks
- Re-launching Octopus focuses the main window instead of opening a new instance
