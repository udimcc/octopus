# Split Groups — Design

**Date:** 2026-10-13
**Status:** Approved (brainstorm)
**Approach:** A — groups owned by the backend (`Task` aggregate); the renderer only draws them
**Replaces:** the per-task-per-window split of `split-panes_2026-10-12-design.md` (unshipped, on branch `session-split`)

## Goal

Fix the product problem with the first split-pane version: there was one split per task per window, and
switching to any other session swapped it into the focused pane. The user wants to keep combinations
fixed — for example claude + code in one split, terminal1 + terminal2 in another — and see a session
that belongs to no split on its own.

## Scope & decisions

| Topic | Decision |
|---|---|
| Group | A set of **2 or more sessions of one task in one window**, with its own split layout tree and a color. A task may have several groups. A session is in **at most one** group. |
| What is shown | The window's mark decides. A **grouped** session shows its whole group, with that pane focused. A **lone** session shows alone; the split disappears. |
| Tab click / next-prev | Only moves the mark; **never changes a group**. Next/prev walks tab by tab: inside a group it moves pane focus, past the group's last tab it shows the next session or group. |
| Joining | Tab menu **"Split right / Split down"**: the tab joins the focused session's group next to the focused pane, forming a new group if the focused session is lone. A session in another group leaves it first. The **split shortcut** creates a new terminal the same way. |
| Leaving | Tab menu **"Remove from group"**: the session becomes lone, its tab placed right after the group. A group with one member left **dissolves**. |
| Ungroup | Right-click the group line → **"Ungroup"**: every member becomes lone, tabs stay in place. No group names. |
| Tab bar look | A **colored line** along the bottom spans the group's tabs. Fixed palette of **6 colors**; a new group takes the first color not used by another group of the task; persisted. |
| Tab order | A group's tabs are always **adjacent**. A member tab reorders only within its group. A lone tab dropped inside a group snaps to the nearest group edge. |
| Moving a group | The **group line is the drag handle**: drag within the bar moves the whole group; drag to another window or out to the desktop moves the **whole group** there. The target window marks the member that was focused in the source. |
| Window close | Closing a window with "move to main" moves its groups to main **intact**. "Kill sessions" removes them. |
| "On screen" for §9.5 | Unchanged: **only the focused pane**. A visible but unfocused group pane still raises the review dot and the state toast. |
| Divider drag | Local while the mouse moves; **one resize command on release**. |
| Shortcuts | The six chords from the first version stay: split right `Ctrl+Shift+E`, split down `Ctrl+Shift+O`, focus pane `Ctrl+Shift+H/J/K/L`. |

## Architecture

### Model (domain)
- The `Task` aggregate holds a list of groups. A group is an id, a layout tree whose leaves are its
  member sessions, and a color index. **Membership is the tree's leaves** — there is no separate member
  list and no group column on sessions, so there is nothing to reconcile.
- `Task` enforces the invariants: one group per session; at least 2 members (dissolve at 1); all members
  share a window; members are contiguous in the task's session order.
- A pure domain tree module holds the tree operations (split a leaf, remove a leaf, set a ratio clamped to
  0.1–0.9 by path, list leaves, validate). The domain cannot import `shared/`, so the tree type is
  re-declared there and mapped to the shared DTO tree at the boundary.
- `Task` never creates ids: the use case passes a new `GroupId` in when a join forms a group.
- Loading tolerates bad saved data: a group with unknown or duplicate leaves, fewer than 2 members, mixed
  windows or non-contiguous tabs is dropped instead of failing the load.

### Commands and events
- New commands: join, leave, ungroup, reorder group, resize group.
- `createSession` gains an optional split intent (anchor session, direction), so the split shortcut creates
  the terminal **inside the group in one command**. The renderer's `pendingSplit` intent is gone.
- Moving or detaching a member moves **every member** of its group. The other members' move events carry
  `cause: 'groupMove'`, reusing the existing `cause` mechanism (as `windowClosed` does), so the target
  window keeps its mark for them and marks only the member that was sent.
- Every group mutation publishes `groupsChanged` with the task's full group list. Order changes still
  publish `sessionReordered`. `groupsChanged` is not session-scoped, so the window registry broadcasts it
  to every window, like other task events.

### Rendering
- The renderer store keeps `groupsByTask` from hydrate and `groupsChanged`, and never mutates a group.
- The mark stays per window. The tree drawn is the mark's group, or nothing (the mark alone).
- The flat render rule is unchanged: every hosted session renders as a sibling keyed by session id with
  absolute percentage boxes, so joining, leaving and switching between a group and a lone session never
  remount a terminal.
- The renderer keeps only geometry: boxes, neighbor lookup for the focus shortcuts, the minimum-size check,
  and a local ratio preview during a divider drag.

### Persistence
- Schema v8 is unshipped, so its DDL is **rewritten in place** (no v9): `session_groups` (group id, task id
  with cascade delete, layout as JSON of session ids, color). The `split_layouts` table is dropped.
- Groups are loaded with their task and travel to the renderer inside the task DTO — no separate layout
  channel.

## Implementation overview (by layer)

| Layer | Change |
|---|---|
| `domain/` | `GroupId`; group tree module; `Task` groups and invariants; contiguity in `reorderSession`; leaf drop on close; group snapshots. |
| `ports/` + persistence | Group upsert, delete and load replace the split-layout methods; v8 rewritten; new group id from the id generator; the domain events. |
| `application/` | Join, leave, ungroup, reorder-group and resize-group use cases; `createSession` split intent; whole-group move and detach; window close keeps or removes groups; close session drops the leaf. `saveSplitLayout` deleted. |
| `shared/` + `main/` + `preload/` | Group DTO on the task DTO, `groupsChanged`, the group channels and `octopusAPI.groups`. `layout:save` removed. |
| Renderer store | `groupsByTask`; group-of-session lookup; deletes `layoutByTask`, `pendingSplit`, the replace logic and the save subscriber. |
| Panes | `TaskView` draws the mark's group; dividers preview locally and send resize on release. |
| Tab bar | Group line with palette color, as drag handle and with an "Ungroup" menu; group-limited tab drag; "Split right / Split down / Remove from group". |
| Shortcuts | Split shortcut creates with the split intent; focus shortcuts move within the shown group; next/prev unchanged. |

No PTY, daemon or protocol change.

## Testing strategy

- **Domain (most of the coverage):** tree operations; `Task` rules — join forms or extends a group, joining
  from another group leaves it, leave places the tab after the group, dissolve at 1, ungroup,
  `reorderSession` keeps members inside and pushes lone tabs to the edge, reorder-group moves the block,
  close drops the leaf, members share a window, color assignment, bad saved groups dropped on load.
- **Application:** each use case persists and publishes `groupsChanged`; `createSession` with the split
  intent joins in one command; moving or detaching a member moves the whole group and only the sent member
  is marked; window close moves groups to main intact or removes them on kill; task delete cascades.
- **Persistence:** v8 on a fresh database and v7 to v8; CRUD; cascade on task delete.
- **Renderer:** store reducers; `TaskView` draws the mark's group and a lone session alone;
  **never remount** when switching group to lone to group and on join or leave; tab bar line spans the
  group in its color, drag limits, line drag and menu; tab menu; shortcuts.
- **Existing tests:** the first version's split tests are rewritten or deleted, not kept alongside;
  `split-layout` keeps only geometry tests.
- **Edge cases:** closing the focused member; a group of 2 losing a member dissolves; an exited member stays
  in its pane; task switch; restart restores groups; a visible unfocused pane still raises the review dot.
- **Manual:** VDI cost with four visible panes; group line drag; whole-group move across windows.

## Risks

- **Terminal remount on restructure.** Mitigated by the unchanged flat render rule and the never-remount test.
- **Tab order rules.** Contiguity changes `reorderSession`, which existing reorder tests depend on.
- **Multi-event group moves.** A group move emits one move event per member; the `groupMove` cause keeps the
  target's mark correct.
- **State-logic drift.** `.claude/rules/claude-state-prd.md` applies: run the co-located tests and the
  PRD-conformance sub-agent.

## Documentation to update with the implementation

- `DESIGN.md` §5.7 rewritten for groups; §3.7 (mark = focused pane of the group; tab clicks never change a
  group); §5.3 (flat render rule unchanged).
- `CLAUDE_STATE_PRD.md` only if its wording refers to the first version's model.
- `TASKS.md` and `CHANGELOG.md`.
