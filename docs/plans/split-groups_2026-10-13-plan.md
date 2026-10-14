# Split Groups - Plan

**Feature**: Backend-owned split groups — a group is 2+ sessions of one task in one window with its own layout tree and color; the mark's group (or the mark alone) is what a window shows. Replaces the renderer-owned per-task-per-window `layoutByTask`.
**Design**: `docs/plans/split-groups_2026-10-13-design.md`

## Wave 1 (parallel)
### [x] Subject 1: Domain — `src/domain/ids.ts`, `src/domain/group-tree.ts` (new), `src/domain/task.ts`, `src/domain/snapshots.ts`

- [x] `GroupId` branded type + `asGroupId` in `ids.ts`
- [x] `group-tree.ts`: domain tree type (re-declared; domain cannot import shared) + `split`, `removeLeaf`, `setRatio` (clamp 0.1–0.9 by path), `leafIds`, `validate`
- [x] `Task` holds groups `{ id, tree, colorIndex }`; `groups()`, `groupOf(sessionId)`
- [x] `join(sessionId, anchorSessionId, dir, newGroupId)`: forms a group if the anchor is lone, else adds next to the anchor's leaf; leaves an old group first (dissolve at 1); moves the tab adjacent to the group
- [x] `leave(sessionId)` (tab placed right after the group; dissolve at 1), `ungroup(groupId)` (tabs in place), `reorderGroup(groupId, toIndex)` (block move), `resizeGroup(groupId, path, ratio)`
- [x] Invariants: one group per session; 2+ members; all members share a window; members contiguous in session order
- [x] `reorderSession`: a member moves only within its group; a lone tab landing inside a group snaps to the nearest edge
- [x] `removeSession` drops the leaf (dissolve at 1)
- [x] Color: palette of 6, first index unused by the task's other groups
- [x] `GroupSnapshot` in `snapshots.ts`; `TaskSnapshot.groups`; `fromSnapshot` drops invalid groups (unknown/duplicate leaves, <2, mixed windows, non-contiguous); `toSnapshot` emits groups

### [x] Subject 2: Shared contract — `src/shared/dto.ts`, `src/shared/events.ts`, `src/shared/ipc.ts`

- [x] `GroupDTO { id, layout: SplitNode, colorIndex }`; `TaskDTO.groups`
- [x] `CreateSessionInput.split?: { anchorSessionId, dir }`
- [x] Group inputs: join, leave, ungroup, reorder group, resize group
- [x] `groupsChanged { taskId, groups }` event DTO; `sessionMovedToWindow.cause` gains `'groupMove'`
- [x] `group:*` channels + `OctopusAPI.groups`
- [x] Remove `SaveSplitLayoutInput`, `WindowedWorkspaceStateDTO.splitLayouts`, `layout:save`, `OctopusAPI.layouts`

## Wave 2 (depends on Wave 1)
### [x] Subject 3: Persistence — `src/adapters/persistence/schema.ts`, `src/adapters/persistence/sqlite-store.ts`, `src/adapters/persistence/mappers.ts`, `src/ports/workspace-persistence.ts`

- [x] Rewrite the v8 DDL in place (no v9): `session_groups (id TEXT PK, task_id → tasks ON DELETE CASCADE, layout TEXT NOT NULL, color INTEGER NOT NULL)`; drop `split_layouts`; mirror in `SCHEMA_STATEMENTS`
- [x] Port: `upsertGroup`, `deleteGroup`, group load replace `saveSplitLayout` / `loadSplitLayouts`
- [x] `SqliteStore` implementation; `load()` attaches groups to their `TaskSnapshot`

### [x] Subject 4: Ports + mappers — `src/ports/event-bus.ts`, `src/ports/id-generator.ts`, `src/adapters/id/uuid-id-generator.ts`, `src/main/dto-mappers.ts`

- [x] `groupsChanged` domain event; `sessionMovedToWindow` cause `'groupMove'`
- [x] `newGroupId()` on the id generator port and the UUID adapter
- [x] `toGroupDTO`; `toTaskDTO` carries groups; `toEventDTO` maps `groupsChanged`; drop the `splitLayoutRows` parameter of `toWindowedWorkspaceStateDTO`

## Wave 3 (depends on Wave 2)
### [x] Subject 5: Application group commands — `src/application/commands.ts`, `src/application/command-loop.ts`, `src/application/use-cases/join-group.ts` (new), `leave-group.ts` (new), `ungroup.ts` (new), `reorder-group.ts` (new), `resize-group.ts` (new), `save-split-layout.ts` (delete), `test-fakes.ts`

- [x] Command kinds + inputs for join, leave, ungroup, reorder group, resize group; `CreateSessionInput.split`; remove `saveSplitLayout`
- [x] Use cases: mutate via `Task`, persist group rows (and session rows when order changes), publish `groupsChanged` (+ `sessionReordered` when order changes); join passes `deps.ids.newGroupId()`
- [x] Wire the loop; delete `save-split-layout.ts` and its test
- [x] `test-fakes.ts`: group persistence in `FakePersistence` (cascade on task delete), `newGroupId` in the fake id generator

## Wave 4 (depends on Wave 3)
### [x] Subject 6: Lifecycle use cases — `src/application/use-cases/open-session.ts`, `move-session-to-window.ts`, `create-window-with-session.ts`, `close-window.ts`, `close-session.ts`

- [x] `openSession` with `split`: add the session and join it in the same command; persist + publish `groupsChanged`
- [x] `moveSessionToWindow` / `createWindowWithSession` on a member move every member; other members' events carry `cause: 'groupMove'`
- [x] `closeWindow`: move-to-main keeps groups intact; kill-sessions removes them
- [x] `closeSession`: drop the leaf, dissolve at 1, persist + publish `groupsChanged`

### [x] Subject 7: IPC — `src/main/ipc-handlers.ts`, `src/preload/index.ts`

- [x] Group handlers (validate inputs defensively, like `layout:save` did); remove the `layout:save` handler and `loadSplitLayouts` from `getState`
- [x] Preload `groups.*`; remove `layouts.save`
- [x] Verify `groupsChanged` broadcasts through `window-registry.ts` (not session-scoped) — no change expected

## Wave 5 (depends on Wave 4)
### [x] Subject 8: Renderer store — `src/renderer/src/store/store.ts`, `src/renderer/src/store/split-layout.ts`, `src/renderer/src/App.tsx`

- [x] `groupsByTask` from hydrate (`TaskDTO.groups`) and `groupsChanged`; `groupOfSession` selector
- [x] Remove `layoutByTask`, `pendingSplit`, the `withMark` replace logic, the save subscriber and `installSplitLayoutPersistence` (and its call in `App.tsx`), and the actions `requestSplit` / `cancelSplit` / `splitWith` / `closePane` / `setSplitRatio`
- [x] `sessionMovedToWindow` with `cause: 'groupMove'` keeps the target's mark
- [x] Tab click / next-prev only move the mark
- [x] `split-layout.ts` keeps geometry only: `toRects`, `splitHandles`, `neighbor`, `leafIds`/`hasLeaf`, `canSplit`, plus `setRatio` for the local drag preview

## Wave 6 (depends on Wave 5)
### [x] Subject 9: Panes — `src/renderer/src/components/TaskView.tsx`, `src/renderer/src/components/SplitDividers.tsx`

- [x] `TaskView`: the drawn tree is the mark's group's layout, or none; flat render rule unchanged
- [x] `SplitDividers`: local ratio preview while dragging; `groups.resize` on release

### [x] Subject 10: Tab bar — `src/renderer/src/components/SessionTabBar.tsx`, `src/renderer/src/components/SessionTab.tsx`, `src/renderer/src/style/tokens.ts`

- [x] 6-color group palette in `tokens.ts`; a line along the bottom spanning each group's tabs
- [x] The line is the group drag handle (taller hit area, grab cursor): in the bar → `groups.reorder`; to another window / out → existing move / detach with the focused member (or the first leaf)
- [x] Line context menu "Ungroup"
- [x] Member tab drag limited to its group; lone tab dropped inside a group snaps to the edge
- [x] Tab menu: "Split right / Split down" → `groups.join` with the mark as anchor (disabled for the mark itself, for a tab already in the mark's group, or when the pane is too small); "Remove from group" for members; remove the `inSplit` marker and "Close pane"

### [x] Subject 11: Shortcuts — `src/renderer/src/hooks/useKeyboardShortcuts.ts`

- [x] Split chords → `sessions.create({ taskId, split: { anchorSessionId: mark, dir } })`, respecting `canSplit`
- [x] Focus chords → `neighbor` within the shown group's tree → move the mark
- [x] Next/prev unchanged

## Wave 7 (depends on Wave 6)
### [x] Subject 12: Docs + state-rule check

- [x] `DESIGN.md`: rewrite §5.7 for groups; §3.7 (mark = focused pane of the group, tab clicks never change a group); §5.3 (flat render rule unchanged)
- [x] `CLAUDE_STATE_PRD.md`: update only if wording refers to the first version's model
- [x] `TASKS.md` and `CHANGELOG.md`
- [x] Run the PRD-conformance sub-agent per `.claude/rules/claude-state-prd.md` (1 conflict: transient source re-mark on group move → queued for FIX ISSUES (1))

## Testing

- [x] `group-tree.test.ts` (new): every tree op; `leafIds`; `validate`; `setRatio` clamp
- [x] `task.test.ts`: join forms/extends; join from another group leaves it (dissolve at 1); leave places tab after group; ungroup; `reorderSession` keeps members inside and snaps lone tabs to the edge; reorder-group block move; close drops leaf; same-window invariant; color assignment; invalid saved groups dropped
- [x] `sqlite-store.test.ts`: v8 fresh and v7→v8 create `session_groups` (no `split_layouts`); CRUD; cascade on task delete; groups attached on load
- [x] Use case tests (new): join, leave, ungroup, reorder group, resize group — persist + publish `groupsChanged` (+ `sessionReordered`)
- [x] `open-session.test.ts`: `split` joins in the same command
- [x] `move-session-to-window.test.ts` / `create-window-with-session.test.ts`: a member moves the whole group; other members carry `cause: 'groupMove'`
- [x] `close-window.test.ts`: move-to-main keeps groups; kill-sessions removes them
- [x] `close-session.test.ts`: leaf dropped; dissolve at 1
- [x] `command-loop.test.ts`, `dto-mappers.test.ts`: new kinds wired; `toGroupDTO`, `toTaskDTO` groups, `groupsChanged`
- [x] `store.test.ts`: `groupsByTask` from hydrate and events; `groupOfSession`; mark moves never change groups; `groupMove` keeps the target's mark; old `layoutByTask` / `pendingSplit` / `withMark` / save-subscriber tests deleted
- [x] **Never-remount (`TaskView.test.tsx`)**: group → lone → group, join, leave and ungroup keep the same xterm instance with no dispose
- [x] `split-layout.test.ts`: geometry tests kept; mutation tests removed
- [x] `SplitDividers.test.tsx`: local preview while dragging; one resize on release
- [x] `SessionTabBar.test.tsx` / `SessionTab.test.tsx`: line spans the group in its color; line drag → reorder group; line "Ungroup"; member drag limited; lone tab snaps; "Split right / down" → join and enablement; "Remove from group"
- [x] `useKeyboardShortcuts.test.tsx`: split chords create with `split`; focus chords within the shown group; next/prev walks into and out of a group
- [x] `stub-bridge.ts`: `groups.*`, no `layouts.save`
- [x] Edge cases: close the focused member (mark moves within the group); a group of 2 loses a member and dissolves; an exited member stays in its pane; task switch; restart restores groups; a visible unfocused pane still raises the review dot
- [ ] Manual: VDI cost with four visible panes; group line drag; whole-group move across windows

## Acceptance Criteria
- Groups live in the `Task` aggregate and `session_groups`; the renderer never mutates a group
- Membership = the tree's leaves; one group per session, 2+ members, same window, adjacent tabs — all enforced by `Task`
- A window shows the mark's group, or the mark alone; tab clicks and next/prev never change a group
- The split shortcut creates the new terminal inside the group in one command
- Moving or detaching a member moves the whole group; the target marks only the sent member
- Window close to main keeps groups intact; kill removes them
- The group line spans the group's tabs in a persisted palette color, drags the whole group, and offers "Ungroup"
- Joining, leaving, ungrouping and switching between a group and a lone session never remount or dispose a `TerminalPane`
- Only the focused pane is "on screen" for the review dot and the state toast
- Groups survive restart; v8 is rewritten in place and `split_layouts` is gone
- No daemon / PTY protocol change; tests, both typechecks and lint (incl. the boundaries rule) pass
