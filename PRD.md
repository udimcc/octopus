# Project Octopus - Product Requirements Document

## Introduction

Project Octopus is an IDE for software developers designed to support multiple task development in parallel. The core idea is to have multiple sessions (terminals or other windows) grouped under a "task". Each task represents a unit of work and can have multiple sessions. Tasks run in parallel, each with its own isolated codebase via git worktrees.

### Example

**Task 1: Add feature 1**
- Session: terminal running Claude Code
- Session: terminal to view project files
- Session: Jenkins pipeline progression viewer

**Task 2: Bug fix**
- Session: terminal running Claude Code
- Session: terminal to view project files

## Tasks

A task represents a unit of work the user needs to complete.

### Lifecycle

- **Creation:** Opening a new task shows a modal with three tabs. **From New Worktree** and **From
  Existing Repo** show a Projects sidebar to pick a configured repository (see Projects below); **No
  Repo** does not need one. **From New Worktree** collects task name, the picked project, source branch
  (prefilled from the project's default branch), and new branch — and on confirm Octopus creates the
  worktree: if the project's repository contains a `create_worktree.sh`, it is run with the source and new
  branch and returns the worktree path; otherwise Octopus creates the worktree itself with git under a
  configurable base directory (default `~/octopus_repos/`). **From Existing Repo** collects task name +
  the picked project + one of its worktrees (its main checkout or a linked worktree), chosen from a list;
  the list shows **Available** worktrees first, then **Used** ones (already used by another task, shown
  disabled), each under its own label, and an empty section is not shown. Octopus adopts the chosen worktree as-is
  (left on disk when deleted). **No Repo** collects a task name only — a task with *no* repository or
  worktree, for ad-hoc/scratch work (checking mounts, viewing a log, editing a config file); nothing is
  created on disk and its sessions open at the user's home directory.
- **Deletion:** When a task is deleted, a managed worktree is removed symmetrically — via the repository's `delete_worktree.sh` if present, otherwise by Octopus with git. An adopted (existing-repo) directory and a No Repo task leave nothing on disk (a No Repo task has no worktree to remove).

### Behavior

- Each task contains multiple sessions.
- When switching tasks, all session windows switch to the selected task's sessions.

## Projects

A project is a one-time configuration entry for a repository, so a user working in a small, stable
set of repositories doesn't have to re-pick the same directory for every new task.

- Projects are configured from the Projects sidebar in the task-creation modal: "+ Add project" opens
  a native folder picker; picking a repository that's already configured just selects the existing
  entry instead of adding a duplicate.
- Each project has a default branch that's auto-detected when it's added — and may be absent, if
  detection finds none — editable at any time from its row; editing it never changes the source
  branch of a task that already used the project.
- A project can be removed once no task belongs to it; removing a project that still has tasks is
  blocked.
- The first time Octopus starts after an upgrade that adds this feature, it seeds one project per
  repository already in use by an existing task, so a user with existing tasks starts with a populated
  list instead of an empty one.

## Issues

An issue is a work item the user tracks inside Octopus: personal issues today, Jira issues later.
Issues are created manually and stored locally. They survive restart.

### Fields

- **Name** (required).
- **Description**, written and shown as markdown.
- **Project** (optional): one of the configured Projects (above).
- **Status**: one of a fixed set, each with its own icon. Users cannot add or remove statuses.
  1. **Todo** (the default for a new issue)
  2. **In progress**
  3. **In review**
  4. **Done**

### Issues and tasks

Binding is optional. A task can exist without an issue and an issue without a task, but an issue is
bound to **at most one** task and a task to **at most one** issue.

There are three ways to bind:
- **Link task** (from the issue view):
  - Tasks are grouped by project, the same way as in the Progress window's task list.
  - Tasks already bound to another issue are grayed out ("already linked").
  - If this issue is already bound, its old binding is replaced without a prompt.
- **Create task** (from the issue view): opens the task-creation modal on **From New Worktree**,
  prefilled:
  - task name = the issue name;
  - the issue is locked in;
  - the issue's project is picked, with the new branch derived from the name.

  An issue with no project opens with no project picked.
- **Associated issue** (in the task-creation modal): an optional picker on all three tabs.
  - It lists issues that are not Done. Issues already bound are grayed out ("already linked").
  - Picking an issue fills the task name and branch if they are empty, and selects the issue's
    project if no project is picked yet.

Binding rules:
- **The only automatic status change:** when an issue becomes bound by any of these three paths, its
  status moves to **In progress** if it was **Todo**. Any other status is left unchanged.
- When a binding ends (Unlink task, or deleting only the task), the issue's status is left unchanged.
- A task created with an issue is bound only once the task is **ready** (its worktree exists).
  - If creating the task fails, the issue stays unbound.
  - If the issue was bound to another task while this one was being created, the task is still
    created, unbound, and a notification says so.

### Deleting

- **Deleting a bound task or a bound issue** shows a warning with four choices:
  - **Delete task only** or **Delete issue only**;
  - **Delete both**;
  - **Cancel**.
- The task's usual "uncommitted changes — delete anyway?" step still applies. With **Delete both**,
  the issue is deleted only if the task is actually deleted. If the user cancels that step, or the
  task deletion fails, nothing is deleted and the binding remains.
- **Deleting an unbound issue** asks for a simple confirmation.
- **Removing a project** that issues refer to is allowed: those issues just lose their project. Tasks
  still block a project's removal, as before.

### Issues window

The Issues window is a large panel. It is **not a session**, is not tied to any task, and opens and
closes regardless of which task is active.

**Opening and closing:**
- Open it from the **Issues** button at the bottom left of the Progress window, below the tasks, or
  with the keyboard shortcut (default **Alt+Shift+I**, configurable in Settings → Keybindings).
- It slides in from the right and covers the whole session area, up to the Progress window, which
  stays visible.
- **Esc**, the **Issues** button, or the shortcut closes it.
- It belongs to the **main window** only. Pressing the shortcut in a secondary window brings the main
  window to the front and toggles its Issues window.
- It always starts closed after a restart.

**Layout:** a split view, with the issue list on the left and the selected issue on the right.

- **Issue list:**
  - Issues are grouped by status, in the order Todo, In progress, In review, Done.
  - Each group can be collapsed. **Done** starts collapsed.
  - Within a group, issues are shown newest first.
  - Each row shows the status icon, the name, a one-line preview of the description, and (when
    set) the project and the linked task.
  - **+ New Issue** opens an empty issue in the right pane, ready to edit. **Save** creates it (the
    name is required); **Cancel** discards it.
- **Issue view:**
  - The description is rendered as markdown. Links open in the system browser, and Octopus never
    navigates away.
  - **Edit** makes the name, description and project editable, with explicit **Save** and
    **Cancel**.
  - Unsaved edits ask "Discard unsaved changes?" before the user selects another issue, closes the
    window, or presses Esc.
  - Below the name, a toolbar holds the **status** dropdown and the buttons: **Edit**, **Create
    task**, **Link task**, **Unlink task** (shown when bound) and **Delete**. As in Jira, the status
    is changed right there, at any time, and is not part of the Edit form.
  - Status icons: Todo is a dashed circle, In progress a play mark, In review an eye, Done a check.

**On the task side:** a bound task shows its issue's status icon on its row in the Progress window.
Hovering the icon shows the issue name; clicking it opens the Issues window on that issue.

### Future

- Fetch issues from Jira; instructions will come later.
- A Kanban board tab in the Issues window.
- Start a Claude brainstorm conversation from a generated prompt based on the issue description.

## Sessions

A session is a window containing a developer tool needed for task completion.

### Session Types

1. **Terminal** - Interactive terminal starting in the task's worktree directory (or, for a No Repo task, the user's home directory). Used for Claude Code, file viewing, running scripts, etc.
2. **Jenkins Pipeline Viewer** (Phase 3) - Displays pipeline progression for the task's branch.
3. Potentially more types in future phases.

### Opening a Session

When opening a session, the developer chooses the desired session type from a dropdown.

### Session State (Phase 2+)

Each session continuously evaluates what it is doing and displays a **status icon** on its tab.
There are three visible statuses (plus an invisible "unknown"):

1. **Idle** — the session is alive but doing nothing; it is waiting for the user to give it a command.
2. **Working** — the session is actively doing something (a command is running, an agent is thinking).
3. **Needs input** — the session has stopped and is waiting for the *user* to intervene before it can
   continue (e.g. Claude Code is asking permission to run a tool). This is the highest-attention status.
4. *(Unknown)* — the session cannot yet tell what it is doing; **no icon is shown** so an un-evaluated
   session never masks a more urgent one.

Status reflects **only a program that reports its own state.** In practice that means **Claude Code**:

- **A plain terminal / shell:** always *Unknown* (no icon). Running an ordinary command, or sitting at the
  prompt, never lights up a status — a bare terminal is not something Octopus tries to interpret.
- **Claude Code:** *Working* while thinking/using tools, *Idle* when it finishes its turn, *Needs input*
  when it is blocked asking the user (e.g. a permission prompt). As soon as Claude exits, the session goes
  back to *Unknown*.
- The status mapping is **pluggable** — a future program (or the Phase 3 Jenkins viewer) can supply its own
  mapping and report the same statuses — but anything that does not report its own state stays *Unknown*.

**"Ready for review" highlight.** Because the point of Octopus is to run many agents in parallel, a session
that has **just finished** (transitioned Working → Idle) while you were not looking at it is shown with a
distinct **ready-for-review** highlight (a solid green icon) rather than a plain idle icon, so you can
tell at a glance *which* of your parallel agents is done and awaiting your review. The highlight clears the
moment you open (focus) that session; a session that was always idle, or that you have already seen, shows
the plain idle icon. This highlight is a purely visual cue — it is not a new state a session "is in".

The highlight applies **only while the session is idle**. If the agent starts working again before you
look (e.g. it picks up a queued instruction, or a sub-agent resumes), the **Working** indicator takes
precedence — a session that is *currently* working or needs input is **never** shown as ready-for-review,
even if it briefly finished a moment ago. In other words the highlight is superseded the instant the session
does anything new; it only ever decorates a session sitting idle with unseen finished work.

Sessions report their state to the parent task.

## Progress Window

A window listing all task names. Located on the left side of the screen.

### Behavior

- Clicking a task switches to it and displays all its sessions.
- Each task name shows a **single status icon** (Phase 2+) summarizing all of its sessions:
  1. **Idle** — every session is idle (waiting for a command).
  2. **Working** — at least one session is working.
  3. **Needs input** — at least one session needs the user (highest priority; demands attention).
  4. *(Unknown)* — no session has a known status yet → no icon.
- **A task shows one status derived from all its sessions by highest-priority-wins.** The task icon folds
  the ready-for-review highlight into a single ordering across every session, highest → lowest:
  1. **Needs input** — at least one session needs the user (demands attention first).
  2. **Ready for review** — at least one *idle* session just finished unseen (see the highlight above).
  3. **Working** — at least one session is working.
  4. **Idle** — everything is idle with nothing to review.
  5. *(Unknown)* — no session has a known status → no icon.

  The most-urgent session decides the task icon, so a single blocked agent is never hidden by idle siblings,
  and a finished-and-unseen session surfaces as ready-for-review even while a *different* session in the same
  task is still working. Because ready-for-review is valid only for an idle session (above), a session that
  has resumed working contributes **Working**, not ready-for-review — so the task icon can never show a
  stable "ready" dot while one of its agents is actually running.

### Controls

- **New Task** button at the top of the window — opens the task-creation modal (name, a configured project, source branch, new branch).
- **Delete Task** button at the top of the window. Deleting a task bound to an issue offers Delete
  task only / Delete issue only / Delete both / Cancel (see Issues → Deleting).
- **Issues** button at the bottom left of the window (below the task list) — toggles the Issues
  window (see Issues → Issues window).

## UI Layout

```
+------------------+---------------------------------------------------+
|                  |  [+ New Session v]  [Tab1] [Tab2] [Tab3]          |
|  Progress Window |---------------------------------------------------|
|                  |                                                   |
|  [+ New Task]    |                                                   |
|  [Delete Task]   |              Session Content                      |
|                  |                                                   |
|  > Task 1       |                                                   |
|    Task 2       |                                                   |
|    Task 3       |                                                   |
|                  |                                                   |
|  [Issues]        |                                                   |
+------------------+---------------------------------------------------+
```

- **Left side:** Progress window with task list and controls.
- **Right side:** Task window containing session content.
- **Top of task window:** Session tabs (clickable) and a "New Session" dropdown button on the top-left.
- **Issues window:** when open, slides in from the right and covers the whole right side (session tabs
  and content), leaving the Progress window visible; its toggle button sits at the bottom of the
  Progress window.

## Phases

### Phase 1

- Tasks, sessions, and progress window.
- Terminal session type.
- No session or task state indicators.

### Phase 2

- **Session state evaluation** — a session shows Idle / Working / Needs input **only** when a program that
  reports its own state is running inside it (Claude Code via its hooks); a plain terminal stays Unknown.
- **Per-program status mapping is pluggable** — Claude Code ships in Phase 2; other programs and future
  session types add their own mapping without changing the aggregation or the icons.
- **Task state derived from session states** by worst-wins aggregation.
- **Status icons** in the progress window (per task) and on session tabs (per session).
- **Ready-for-review highlight** — sessions/tasks that just finished while unattended are visually flagged
  until opened.

### Phase 3

- New session type: Jenkins Pipeline Viewer.
- Connects to Jenkins to display pipeline progression.
- Reports pipeline state back to the task.
