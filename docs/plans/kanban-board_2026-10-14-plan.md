# Kanban Board - Plan

**Feature**: A Board tab in the Issues drawer: status columns, compact cards, drag-and-drop to change status,
shared selection with the List tab, and a unified drawer header.
**Design**: `docs/plans/kanban-board_2026-10-14-design.md`

## Wave 1
### [x] Subject 1: Update branch

- [x] Fast-forward `kanban-board` to `master` (brings in Issues 04a323b and split groups 3fe02f3; c4bb13e
      is already in master's history, so there are no conflicts)
- [x] Confirm `npm run typecheck`, `npm run lint` and `npm run test` are green

## Wave 2 (depends on Wave 1, parallel)
### [x] Subject 2: Drawer tab view-state (`src/renderer/src/store/store.ts`)

- [x] Add a List/Board tab value next to the drawer's open state: never persisted, never in the hydrated
      app state, initially List
- [x] Add a set-tab action
- [x] Closing or reopening the drawer and re-hydrating the settings do not reset the tab
- [x] Opening the drawer on an issue (task-row icon) keeps the last-used tab

### [x] Subject 3: Static board (new `KanbanBoard.tsx`, `KanbanCard.tsx`)

- [x] Four columns in fixed order, built from the existing `groupIssuesByStatus`; newest first within a
      column
- [x] Column header: `IssueStatusIcon`, the status label and a count
- [x] Each column scrolls vertically on its own
- [x] Columns are equal width with a minimum width; below it the board scrolls horizontally
- [x] An empty column shows "No issues"
- [x] Compact card: name clamped to two lines, project (if any), linked-task indicator with the task name
      (if linked)
- [x] The selected card uses the same highlight as a selected list row
- [x] Clicking a card goes through the existing `selectIssue` action, which keeps the discard-prompt guard

## Wave 3 (depends on Wave 2)
### [x] Subject 4: Drawer layout (`IssuesDrawer.tsx`, `IssueList.tsx`, `IssueDetail.tsx`)

- [x] Drawer header with **+ New Issue** on the left, then `[List] [Board]` tabs
- [x] Move + New Issue from `IssueList` into the header, working on both tabs
- [x] Give the issue-view pane a fixed share of the drawer width (about 60% of today's share, roughly 35%),
      identical on both tabs; the List or Board pane fills the rest
- [x] Remove the list pane's fixed 660px / 50% sizing
- [x] With no selection, show the "Select an issue" placeholder at the same width
- [x] Render List or Board from the tab value, with one shared selection; a tab switch never raises the
      discard prompt and keeps unsaved edits

## Wave 4 (depends on Wave 3, parallel)
### [x] Subject 5: Drag-and-drop (`KanbanBoard.tsx`, `KanbanCard.tsx`)

- [x] Reuse the pointer-capture drag pattern from `SplitDividers.tsx` / `SessionTabBar.tsx`:
  - [x] a window-level pointer-up/pointer-cancel fallback (Electron 33 has no `lostpointercapture`), with
        an "ended" guard;
  - [x] a small threshold separating a click from a drag.
- [x] Drag visuals:
  - [x] the original card dims in place;
  - [x] a lightweight copy follows the pointer, rendered outside the drawer's transform (per
        `.claude/rules/modals-and-overlays.md`) and moved by transform only;
  - [x] the column under the pointer is highlighted;
  - [x] no shadow, blur, filter or reflow animation.
- [x] Dropping on another column (including empty space) calls the same `issues.update` status path as the
      toolbar dropdown, with no prompts, no link/unlink and no task action
- [x] Dropping on the same column or outside all columns does nothing
- [x] Dragging never changes the selection
- [x] Esc during a drag cancels only the drag, intercepted before the drawer's own Esc handling
- [x] Closing the drawer (button or shortcut) mid-drag cancels the drag, since the drawer stays mounted

### [x] Subject 6: Documentation

- [x] `PRD.md` → Issues: replace the "Kanban board tab" Future bullet with a real **Board** subsection
      (layout, columns, cards, drag-and-drop, shared selection, tab memory, issue-view width)
- [x] `DESIGN.md` §13.5: the tab view-state, the board components, the drag pattern, the overlay and VDI
      constraints
- [x] `TASKS.md`: a Board section
- [x] `CHANGELOG.md`: [Unreleased] → Added

## Wave 5 (depends on Subject 5)
### [x] Subject 7: Open on an issue from the task row (`KanbanBoard.tsx`, `IssueList.tsx`)

- [x] On the Board tab, scroll the selected card into view when the selection changes
- [x] On the List tab, auto-expand a collapsed group (e.g. Done) that holds the selected issue, then scroll
      the row into view
- [x] Check that the task-row icon opens the last-used tab with the issue selected

## Testing

- [x] Store: the tab defaults to List and is kept across close/reopen and hydrate; it is not persisted
- [x] Board: four columns always render; cards are in the right columns, newest first; an empty column shows
      "No issues"; a click selects; the selected card is highlighted
- [x] Drag: a drop on another column calls `issues.update` with the new status; same-column and outside
      drops make no call; Esc cancels without closing the drawer; closing the drawer mid-drag cancels;
      the selection is unchanged; a drop on an empty column works
- [x] Drawer: switching tabs keeps the selection and unsaved edits without a prompt; the issue view has the
      same width share on both tabs; the placeholder shows with no selection; + New Issue works on both
      tabs
- [x] Task-row icon: opens the last-used tab; on List, a collapsed Done group auto-expands
- [x] Update the existing `IssueList` / `IssuesDrawer` tests for the moved + New Issue button and the new
      pane widths
- [x] `group-issues.test.ts` still passes, unchanged
- [x] Edge cases: a linked issue dropped on Done (the task is untouched and stays linked); the selected issue
      deleted while on Board (placeholder); "Delete both" from the Progress window while the board is open
      (the card disappears); many Done issues (only that column scrolls); a long name (two-line clamp);
      a narrow window (horizontal scroll)
- [ ] Manual smoke test on the VDI: drag smoothness and no visual stalls

## Acceptance Criteria
- The drawer header has `[List] [Board]` tabs and + New Issue, which works on both tabs
- The Board shows four always-expanded columns whose counts match the List groups
- Dragging a card to another column changes its status through the same path as the dropdown, with no
  side effects
- A drop on the same column or outside does nothing; Esc or closing the drawer mid-drag cancels the drag
- Dragging never changes the selection, and unsaved edits survive a drag
- One shared selection: a tab switch keeps the open issue and its unsaved edits, with no prompt
- The last-used tab is remembered for the app run only; after a restart the drawer opens on List
- The task-row icon opens the last-used tab with the issue visible (a collapsed group auto-expands)
- The issue view takes the same share of the drawer on both tabs
- No new npm dependencies; no blur, filter, shadow or reflow animation
- All existing tests pass, and new tests cover the Testing section
- PRD, DESIGN, TASKS and CHANGELOG are updated
