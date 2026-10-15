# Kanban Board — Design

**Date:** 2026-10-14
**Status:** Approved (brainstorm, product level)
**Builds on:** Issues (`docs/plans/issues_2026-10-13-design.md`, merged to master as 04a323b)
**Product spec:** `PRD.md` → *Issues* (its "Kanban board tab" Future bullet becomes a real section)

## Motivation

The Issues drawer lists issues grouped by status. A Kanban board shows the same issues as status
columns, so the user can see where all of their work stands at a glance and move an issue to a new
status by dragging its card.

## Product decisions

### Approach

**Drawer-level tabs with one shared selection** (Approach A) was chosen over a List/Board toggle in the
left pane and over independent tabs that each keep their own selection.

### Layout and navigation

- **Drawer header (new):** **+ New Issue** on the left, then the `List` and `Board` tabs, set a little apart
  (revised after implementation; first the tabs were on the left and + New Issue on the right).
  - + New Issue moves here from the top of the list pane and works on both tabs. New issues still
    start as Todo and open in the issue view in edit mode.
  - Future Jira fetch will also live in this header.
- **Issue view width:**
  - The issue view has one width that is identical on both tabs: a fixed **share of the drawer**,
    roughly 61% of the drawer, so the List/Board pane gets ~39%. (Revised after implementation:
    first 35%, then the user asked to cut the List/Board pane to 60% of its 65%.)
  - It scales with the window. The List or Board pane fills the rest, so the List tab also gets wider.
- **Placeholder:** with no issue selected, the issue-view pane keeps its width and shows "Select an
  issue".
- **One shared selection:** switching tabs keeps the same issue open, including unsaved edits. A tab
  switch never raises "Discard unsaved changes?".
- **Tab memory:**
  - The drawer opens on the last-used tab for the current app run, and on List after a restart. This
    matches the drawer's own state, which is never saved.
  - The issue icon on a task row opens the drawer on the last-used tab, with that issue selected and
    scrolled into view.
  - On the List tab, a collapsed group (e.g. Done) expands automatically so the selected row is
    visible. This also fixes that behavior on the existing List tab.

### Board

- **Columns:**
  - Todo, In progress, In review, Done, always in that order. They are equal width and always
    expanded, Done included.
  - Each header shows the status icon, the status name and a count.
  - Each column scrolls vertically on its own.
  - Columns keep a minimum readable width. Below it the board scrolls horizontally, and the issue-view
    width is unaffected.
- **Cards** (compact):
  - The name, wrapped to at most two lines, then an ellipsis.
  - The project, if the issue has one.
  - A linked-task indicator with the task name, if the issue is linked.
  - The selected card uses the same highlight as the selected row in the List tab.
- **Click:** clicking a card selects it and shows it in the issue view. If the open issue has unsaved
  edits, the existing discard prompt appears first, exactly as when the user clicks another row in the
  List tab.
- **Order:** newest first within each column, as in the List tab. There is no manual ordering.
- **Empty column:** shows "No issues" and still accepts drops.
- **No filter** for now. Cards already show their project. A future filter would apply to both tabs.

### Drag-and-drop

- **Drop on another column** (anywhere in it, including empty space): the status changes exactly as if
  the user picked it in the toolbar status dropdown.
  - There are no prompts, no link or unlink, and no task action. A linked issue dropped on Done keeps
    its task, which stays linked.
  - The card lands in its sorted position.
- **Drop on the same column, or outside all columns:** nothing changes, and the card returns.
- **Selection:** dragging never changes the selection.
- **Dragged issue open in the issue view:**
  - If it has unsaved edits, the status still changes and the edits stay in the form. Status is not
    part of the Edit form.
  - If it is the selected issue, the toolbar status updates immediately.
- **Status changed elsewhere** (the dropdown, or the Todo → In progress rule on linking): the card
  moves to its new column immediately.
- **Esc:** during a drag, Esc cancels only the drag. A second Esc closes the drawer as usual.
- **Closing the drawer mid-drag** (button or shortcut): the drag is cancelled.
- **Feel:**
  - The dragged card dims in place, a lightweight copy follows the pointer, and the column under the
    pointer is highlighted.
  - There are no slide or reflow animations, no blur and no shadows. The VMware VDI has no GPU, and
    heavy motion stalls.
- **Keyboard:** there is no keyboard drag. The toolbar status dropdown is the keyboard and
  accessibility path.

### Out of scope

- Manual card ordering, a project filter, and keyboard moves between columns.
- Jira fetch, which is the next Issues feature.

## Notes for implementation (from code review of master)

- **Status updates:** a drop uses the same status-update path as the toolbar dropdown in the issue
  view. The store then follows the resulting issue event, so the List tab, the Board tab and the task
  row stay consistent.
- **Unsaved edits:** the dirty state covers only name, description and project. Status changes don't
  touch it, which makes "drag with unsaved edits" safe by construction.
- **Drag code:** the split-groups feature already has the pointer-drag pattern to reuse.
  - Electron 33 doesn't report lost pointer capture, so drags also end on a window-level pointer-up.
  - A small movement threshold separates a click from a drag.
- **Overlay rendering:**
  - The drawer slides in using a CSS transform. The dragged card's copy must therefore be rendered
    outside the drawer, as `.claude/rules/modals-and-overlays.md` already requires for dialogs, and
    move by transform only.
  - The drawer is always mounted, so a close must cancel an active drag explicitly.
- **Branch base:** the `kanban-board` branch predates Issues. It is fast-forwarded to master first.

## Acceptance

1. The drawer header has `[List] [Board]` tabs and **+ New Issue**, which works on both tabs.
2. The Board tab shows 4 columns whose counts match the List tab's groups.
3. Dragging a card to another column changes its status. The change shows on the List tab and survives
   a restart.
4. A drop on the same column or outside does nothing. Esc or closing the drawer mid-drag cancels the
   drag.
5. Clicking a card opens the same issue view and toolbar as the List tab, at the same width on both
   tabs.
6. The selection and unsaved edits survive a tab switch without any prompt.
7. The last-used tab is remembered for the app run only.
8. The task-row icon opens the last-used tab with the issue visible.
9. Dragging stays smooth on the VDI. There are no new npm dependencies.

## Testing strategy

- **Scope:** renderer unit and component tests (Vitest, jsdom), plus a manual smoke run on the VDI.
- **New tests:**
  - tab state: default, kept across close/reopen and hydrate;
  - board: columns, order, empty column, click selects, highlight;
  - drag: drop changes status; same-column and outside drops do nothing; Esc cancels; closing
    cancels; selection is unchanged; drop on an empty column works;
  - drawer: shared selection and unsaved edits across tabs; fixed-share width and placeholder;
    + New Issue on both tabs;
  - task-row icon: opens the last-used tab; a collapsed group auto-expands.
- **Existing tests to update:** List and drawer tests for the moved + New Issue button and the new pane
  widths.
- **Edge cases:**
  - a linked issue dropped on Done;
  - the selected issue deleted while on Board;
  - "Delete both" run from the Progress window while the board is open;
  - many Done issues;
  - very long names;
  - a narrow window.
