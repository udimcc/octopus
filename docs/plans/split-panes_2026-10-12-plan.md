# Split Panes - Plan

**Feature**: tmux-like recursive split panes for sessions of one task inside one window, persisted per task + window.
**Design**: `docs/plans/split-panes_2026-10-12-design.md`

## Wave 1 (parallel)
### [x] Subject 1: Shared types — `src/shared/dto.ts`

- [x] Add the `SplitNode` union (leaf with session id; split with direction row/col, ratio, two children)
- [x] Add optional `splitLayouts` (task id → layout JSON) to `WindowedWorkspaceStateDTO`
- [x] Add `SaveSplitLayoutIpcInput` (task id, window id, layout string or null for delete)

### [x] Subject 2: Pure layout module — `src/renderer/src/store/split-layout.ts` (new)

- [x] `split(tree, anchorId, dir, newId)` — replace the anchor leaf with a split of anchor + new leaf
- [x] `remove(tree, id)` — drop the leaf, collapse its parent to the sibling; undefined when empty
- [x] `replace(tree, oldId, newId)` — swap the session shown in a leaf (hidden tab into focused pane)
- [x] `setRatio(tree, path, ratio)` — clamp to 0.1–0.9
- [x] `neighbor(tree, id, left|right|up|down)` — adjacent leaf or undefined at the boundary
- [x] `toRects(tree)` — percentage boxes per leaf, tiling the area with no overlap
- [x] `prune(tree, validIds)` — drop unknown ids, collapse single-child splits, one leaf → unsplit, garbage → unsplit
- [x] `leafIds(tree)` and `canSplit(…)` (minimum ~20 cols × 5 rows from pane pixel size + cell size)

### [x] Subject 3: Persistence — `src/adapters/persistence/schema.ts`, `src/ports/workspace-persistence.ts`, `src/adapters/persistence/sqlite-store.ts`

- [x] Bump `SCHEMA_VERSION` 7 → 8; append migration v8 creating `split_layouts` (task id → tasks ON DELETE CASCADE, window id → windows ON DELETE CASCADE, layout TEXT NOT NULL, PK task + window)
- [x] Add the identical DDL to `SCHEMA_STATEMENTS` for fresh-DB bootstrap (v3/v4 pattern)
- [x] Verify the main window always has a `windows` row so the FK holds
- [x] Port + SqliteStore: `saveSplitLayout(taskId, windowId, json | undefined)` (upsert / delete), `loadSplitLayouts(windowId)`

### [x] Subject 4: Settings chords — `src/ports/settings-store.ts`, `src/adapters/settings/json-settings-store.ts`, `src/shared/dto.ts`, `src/main/dto-mappers.ts`

- [x] Add `splitRightKey` (`Ctrl+Shift+KeyE`), `splitDownKey` (`Ctrl+Shift+KeyO`), `focusPaneLeftKey` / `focusPaneRightKey` / `focusPaneUpKey` / `focusPaneDownKey` (`Ctrl+Shift+KeyH/KeyL/KeyK/KeyJ`; changed in review from `Ctrl+Alt+Shift+Arrow*`, which GNOME grabs) to settings, patch, DTO, defaults, merge, and mapper

## Wave 2 (depends on Wave 1)
### [x] Subject 5: Persist-only command — `src/application/commands.ts`, `src/application/use-cases/save-split-layout.ts` (new), `src/application/command-loop.ts`

- [x] `SaveSplitLayoutInput` + `saveSplitLayout` command kind
- [x] Use case writes through the persistence port only — no bus event (mirror `focus-session.ts`)
- [x] Wire the case in the command loop

### [x] Subject 6: IPC + hydrate — `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-handlers.ts`, `src/main/dto-mappers.ts`

- [x] Fire-and-forget channel `layout:save`; `octopusAPI.layouts.save(input)`
- [x] `ipcMain.on` handler dispatching the command to the loop
- [x] `getState` includes this window's layouts

### [x] Subject 7: Store — `src/renderer/src/store/store.ts`

- [x] `layoutByTask` and `pendingSplit` in `StoreData` / `initialData`
- [x] Hydrate: parse, prune against hosted sessions, and set the mark to the first leaf if the persisted mark is not a leaf
- [x] `sessionCreated`: consume `pendingSplit` only for the same task hosted in this window → split the anchor and mark the new session
- [x] `sessionClosed` and `sessionMovedToWindow` (moving out): remove the leaf, move the mark to the sibling; arrivals stay unsplit
- [x] Actions: `splitWith(sessionId, dir)` (existing session), `requestSplit(dir)` (sets `pendingSplit`), `closePane(sessionId)`, `focusPane(sessionId)`, `replaceFocused(sessionId)`, `setRatio(taskId, path, ratio)`
- [x] One debounced store subscriber that diffs `layoutByTask` and sends `layouts.save` per changed task (catches reducer-driven prunes too)

## Wave 3 (depends on Wave 2)
### [x] Subject 8: TerminalPane — `src/renderer/src/terminal/TerminalPane.tsx`, `src/renderer/src/session-views/session-view-factory.ts`

- [x] Split `active` into `visible` (fit/resize, renderer tier / WebGL lease, scroll-intent capture/restore) and `focused` (`term.focus()`)
- [x] Update `SessionViewProps` (no rect — positioning stays in `SessionPane`)
- [x] Add the six new chords to the custom key handler's drop list

### [x] Subject 9: Pane layer — `src/renderer/src/components/SessionPane.tsx`, `src/renderer/src/components/TaskView.tsx`, `src/renderer/src/components/SplitDividers.tsx` (new)

- [x] `SessionPane`: `rect` / `visible` / `focused` props; focus outline; mousedown → focus pane + `sessions.focus`
- [x] `TaskView`: render every hosted session flat with `key = sessionId`; leaves get rects from `toRects`; non-leaves stay hidden; unsplit path identical to today
- [x] `SplitDividers`: overlay gutters per split node, drag → `setRatio`

## Wave 4 (depends on Wave 3)
### [x] Subject 10: Tab bar — `src/renderer/src/components/SessionTabBar.tsx`, `src/renderer/src/components/SessionTab.tsx`

- [x] Visible-in-split marker on tabs
- [x] Context menu: "Split right" / "Split down" (that tab's existing session next to the focused pane; disabled if already visible), "Close pane" (only when in a split; unsplit, session lives)
- [x] Click semantics while split: hidden tab → replace the focused pane; visible tab → focus its pane

### [x] Subject 11: Shortcuts — `src/renderer/src/hooks/useKeyboardShortcuts.ts`

- [x] Split chords → `requestSplit(dir)` + `sessions.create({taskId, windowId})` (respect `canSplit`)
- [x] Directional focus chords → `neighbor` → focus pane
- [x] Next/prev session while split: a hidden target replaces the focused pane, a visible target is focused; the cross-window walk is unchanged

### [x] Subject 12: Settings UI — `src/renderer/src/components/SettingsModal.tsx`

- [x] Six new chord fields; the existing conflict validation covers them

## Wave 5 (depends on Wave 4)
### [x] Subject 13: Docs + state-rule check

- [x] `DESIGN.md`: new "Split panes" subsection under §5; §5.3 flat render rule; §3.7 mark = focused pane
- [x] `CLAUDE_STATE_PRD.md`: a visible but unfocused split pane is not "on screen"
- [x] `TASKS.md` entries; `CHANGELOG.md` entry
- [x] Run the PRD-conformance sub-agent per `.claude/rules/claude-state-prd.md`

## Testing

- [x] `split-layout.test.ts` (new): every op; `toRects` tiling / no-overlap for nested row/col; `neighbor` incl. boundaries; `prune` (unknown ids, single-child collapse, one leaf, garbage); `canSplit` refusal
- [x] `store.test.ts`: `pendingSplit` consumed only by a same-task creation hosted here (not another task or window); close / move-out prune + mark to sibling; hydrate prune + mark fix; `isSessionFocused` true only for the focused leaf (visible unfocused pane still raises review); save subscriber fires after reducer prunes
- [x] `sqlite-store.test.ts`: v7 → v8 migration; save / update / delete / load; cascade on task delete and window delete
- [x] `save-split-layout.test.ts` (new): persists, emits no event (mirror `focus-session.test.ts`)
- [x] **Never-remount test (TaskView):** split, unsplit, replace, sibling close keep the same xterm instance with no dispose
- [x] `TerminalPane.test.tsx`: visible-not-focused fits but does not focus; the key guard drops the six chords
- [x] `SessionTabBar.test.tsx` / `SessionTab.test.tsx`: menu items + enablement; hidden-tab replace; visible-tab focus
- [x] `useKeyboardShortcuts.test.tsx`: split chords set intent + create; directional focus; next/prev while split
- [x] `SettingsModal.test.tsx`: new fields and conflict detection
- [x] Edge cases: closing the focused pane's session; task switch while split; exited session stays in its pane; window close with layout (rows cascade, sessions return to main unsplit); minimum-size refusal
- [ ] Manual: DOM-renderer cost on the VDI host with four visible panes

## Acceptance Criteria
- Restructuring the split (split, unsplit, replace, sibling close) never remounts or disposes a `TerminalPane`
- Splits hold sessions of the same task only, within one window
- Only the focused pane is "on screen" for the review dot and the state toast; `isSessionFocused` is semantically unchanged
- Layouts survive app restart (forward-only migration v8); stale layouts are pruned on hydrate
- A session moved to another window arrives unsplit; closing a pane keeps the session as a hidden tab
- Minimum pane size is enforced; no hard pane-count cap
- The six new chords are configurable, conflict-checked, and never reach the PTY
- No daemon / PTY protocol change; all existing tests, typecheck, and lint (incl. the boundaries rule) pass
