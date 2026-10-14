# Issues — Design

**Date:** 2026-10-13
**Status:** Approved (brainstorm)
**Product spec:** `PRD.md` → *Issues*

## Motivation

Let the user manage all of their issues inside Octopus: personal issues now, Jira issues later. An
issue can optionally be bound to a task, so the work item and the worktree and sessions that implement
it stay connected.

## Product decisions

### Issue

- Fields: **name** (required), **description** (markdown), optional **project**, **status**.
- **Project** is one of the configured Projects, the same list the New-Task modal uses. It is optional.
- **Status** is a fixed set: *Todo*, *In progress*, *In review*, *Done*. Each status has its own icon.
  Users cannot add or remove statuses.
- Issues are stored locally and survive restart. There is no Jira field yet (YAGNI); Jira import will be
  added in a later migration.

### Binding issues and tasks

- Binding is optional and 1:1 in both directions. A task can exist without an issue, and an issue
  without a task.
- There are three ways to bind:
  - **Link task** from the issue view. Tasks already bound to another issue are grayed out
    ("already linked"). If this issue is already bound, its old binding is replaced without a prompt.
  - **Create task** from the issue view. This opens the New-Task modal prefilled:
    - name = issue name;
    - the issue is locked in;
    - the *From New Worktree* tab is selected, with the issue's project picked and the new branch
      derived from the name.

    With no project, no project is picked.
  - **Associated issue** picker in the New-Task modal, available on all three tabs:
    - It lists issues that are not Done; bound issues are grayed out ("already linked").
    - Picking an issue fills an empty task name and branch, and selects the issue's project if none
      is picked yet.
- **The only automation:** any bind moves the status from *Todo* to *In progress*. Other statuses are
  left unchanged.
- Unbinding (Disconnect, or deleting only the task) leaves the status unchanged.
- A task created from an issue is bound only once the task becomes **Ready**:
  - If provisioning fails, the issue stays unbound.
  - If the issue was bound elsewhere while the task was provisioning, the task is created unbound and
    a toast explains why.

### Deletion

- **Bound task or bound issue:** a dialog offers *Delete task only*, *Delete issue only*, *Delete both*
  and *Cancel*.
- The existing uncommitted-changes step for a task's worktree still applies. *Delete both* deletes the
  issue only if the task deletion succeeds. If the user cancels the uncommitted-changes step, or the
  deletion fails, nothing is deleted and the binding remains.
- **Unbound issue:** a simple confirm.
- **Removing a project** that issues reference is allowed; those issues lose their project. Tasks still
  block project removal, as they do today.

### UI

- An **Issues** button sits at the bottom left of the Progress panel, below the tasks.
- The shortcut is **Alt+Shift+I** by default and can be changed in Settings → Keybindings.
- The button, the shortcut or Esc toggles the **Issues drawer**:
  - It is a large panel that slides in from the right and covers the whole session area, but not the
    Progress panel.
  - It is not a session and is not tied to any task.
  - It exists only in the main window. Pressing the shortcut in a secondary window brings the main window
    to the front and toggles its drawer.
  - Its open/closed state is not saved; it starts closed.
- **Drawer layout:** a split view, with the issue list on the left and the issue view on the right.
  - The list is grouped by status (Todo, In progress, In review, Done). Each group can be collapsed, and
    Done starts collapsed. Issues are listed newest first, with no manual ordering.
  - **+ New Issue** opens an empty issue in the right pane, in edit mode. Save creates it, with status
    Todo by default; Cancel discards it.
- **Issue view:**
  - The description is rendered as markdown, with GitHub-style tables and checklists. Raw HTML is not
    rendered.
  - http/https links open in the system browser. Other link types are ignored, and the app window never
    navigates away.
  - **Edit** makes the name, description and project editable, with explicit **Save** and **Cancel**.
  - The status dropdown works outside edit mode.
  - Buttons: **Delete**, **Create task**, **Link task**, **Disconnect**.
  - Unsaved edits trigger a "Discard unsaved changes?" prompt when the user selects another issue,
    closes the drawer, or presses Esc.
- **Task row:** a bound task shows its issue's status icon, with the issue name on hover. Clicking the
  icon opens the drawer on that issue.

### Future (out of scope)

- Fetch issues from Jira.
- Kanban board tab in the drawer.
- Start a Claude brainstorm conversation from an issue's description.

## Architecture

Approach A was chosen: Issue is a domain aggregate whose changes go through the single-writer command
loop.

- **Domain:** a new `Issue` entity and `IssueStatus` enum, plus an `IssueId`.
  - The `Workspace` aggregate owns the issues collection and enforces the 1:1 binding as new invariant
    I19.
  - The binding is stored **only on the issue**; the task side is looked up in reverse.
  - The todo → in progress rule runs inside the bind operation itself.
- **Persistence:** schema migration v8 adds an `issues` table. Its task reference is UNIQUE, nullable,
  and set to NULL when the task row is deleted. Migrations stay forward-only and append-only. An older
  build refuses a v8 database, and a v7 backup is written on upgrade.
- **Application:**
  - New commands: create, update, delete, bind and unbind issue.
  - Task creation accepts an optional issue and binds it in the same transaction that persists the
    Ready task.
  - Task deletion accepts an "also delete issue" flag, which is applied only in the final delete
    transaction.
  - Removing a project clears the project on any issues that reference it.
  - The hydration state includes the issues.
- **Contract (shared / main / preload):**
  - Issue DTOs, issue IPC channels and API group, and issue upserted / deleted events.
  - A drawer-toggle relay: the main process raises the main window and tells only it to toggle.
  - A validated open-external-link channel.
  - Navigation and window-open guards. Terminal web links are routed through the same safe opener.
- **Renderer:**
  - The store keeps the issues projection, plus drawer view-state that is never persisted.
  - New components: drawer, list, issue view, status icon, markdown renderer, connect-task picker,
    bound-delete dialog, discard prompt.
  - Changes to the New-Task modal (picker and prefill), the delete-task confirm (four choices), the task
    row icon, the Progress panel button, and keybinding settings.
- **New dependency:** a markdown renderer that outputs React elements (react-markdown + remark-gfm), from
  the internal Artifactory npm proxy.

### Data flow

The drawer UI calls the backend over IPC. The main process maps each call to a command, and the command
loop mutates the Workspace and then persists to SQLite. Domain events (issue upserted / deleted) travel
back over the event stream to the renderer store, which is only a projection and is hydrated from the
app state at startup.

### Constraints respected

- The hexagonal dependency rule, enforced by ESLint boundaries.
- The single-writer loop serializes every binding change.
- The VMware VDI environment has no GPU, so the drawer animates with a transform only: no backdrop blur
  or filter.
- Air-gapped: dependencies come only from Artifactory.

## Testing strategy

- **Scope:** unit and component tests next to the code (the Vitest node and jsdom projects), one
  integration test through the command loop, a real-SQLite probe, and a manual smoke run of the app in
  dev mode.
- **New tests:**
  - Domain: validation, the 1:1 binding, and todo → in progress only from Todo.
  - Persistence:
    - migrating an existing database from v7 to v8;
    - saving and reloading issues;
    - deleting a task clears its issue's binding;
    - the uniqueness of the task reference.
  - Use cases: issue CRUD; binding rejected when the task is already bound; bind on Ready versus
    failure versus a concurrent binding; delete both only on success, including the uncommitted-changes
    cancel; project removal clearing issue projects.
  - Renderer:
    - store reducers;
    - list grouping and order;
    - edit, save and cancel, plus the discard prompt;
    - picker graying;
    - the bound-delete dialog;
    - drawer toggles;
    - link filtering.
- **Existing tests to update:**
  - task create / delete;
  - project removal;
  - app state;
  - SQLite store and mappers;
  - command loop;
  - New-Task modal and delete-task confirm;
  - Progress panel and Settings;
  - keyboard shortcuts, store and terminal pass-through.
- **Edge cases:**
  - the issue bound elsewhere while a task created from it is provisioning;
  - delete both, then cancel at the uncommitted-changes step;
  - Esc while editing;
  - unsafe link schemes;
  - rolling back to a pre-v8 build.
