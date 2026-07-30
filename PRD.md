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

- **Creation:** Opening a new task shows a modal collecting four inputs — task name, repository directory (chosen via a native folder picker), source branch, and new branch. On confirm, Octopus creates the worktree: if the chosen repository contains a `create_worktree.sh`, it is run with the source and new branch and returns the worktree path; otherwise Octopus creates the worktree itself with git under a configurable base directory (default `~/octopus_repos/`).
- **Deletion:** When a task is deleted, the worktree is removed symmetrically: via the repository's `delete_worktree.sh` if present, otherwise by Octopus with git.

### Behavior

- Each task contains multiple sessions.
- When switching tasks, all session windows switch to the selected task's sessions.

## Sessions

A session is a window containing a developer tool needed for task completion.

### Session Types

1. **Terminal** - Interactive terminal starting in the task's worktree directory. Used for Claude Code, file viewing, running scripts, etc.
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
distinct **ready-for-review** highlight (a checked/green icon) rather than a plain idle icon, so you can
tell at a glance *which* of your parallel agents is done and awaiting your review. The highlight clears the
moment you open (focus) that session; a session that was always idle, or that you have already seen, shows
the plain idle icon. This highlight is a purely visual cue — it is not a new state a session "is in".

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
- **A task shows one status derived from all its sessions by "worst wins":** if any session needs input the
  task needs input; else if any is working the task is working; else idle. The most-urgent session decides
  the task icon, so a single blocked agent inside a task is never hidden by its idle siblings.
- The **ready-for-review** highlight (above) also aggregates up: a task whose sessions just finished (and you
  haven't looked yet) is highlighted so you can spot completed work while scanning the task list.

### Controls

- **New Task** button at the top of the window — opens the task-creation modal (name, repository directory picker, source branch, new branch).
- **Delete Task** button at the top of the window.

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
+------------------+---------------------------------------------------+
```

- **Left side:** Progress window with task list and controls.
- **Right side:** Task window containing session content.
- **Top of task window:** Session tabs (clickable) and a "New Session" dropdown button on the top-left.

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
