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

- **Creation:** When opening a new task, a new git worktree is created via a user-provided custom script. The script creates the worktree and returns its path.
- **Deletion:** When a task is deleted, the worktree is removed via a user-provided custom script.

### Behavior

- Each task contains multiple sessions.
- When switching tasks, all session windows switch to the selected task's sessions.

## Sessions

A session is a window containing a developer tool needed for task completion.

### Session Types

1. **Terminal** - Interactive terminal starting in the task's worktree directory. Used for Claude Code, file viewing, running scripts, etc.
2. **Jenkins Pipeline Viewer** (Version 3) - Displays pipeline progression for the task's branch.
3. Potentially more types in future versions.

### Opening a Session

When opening a session, the developer chooses the desired session type from a dropdown.

### Session State (Version 2+)

Each session evaluates its state and displays a status icon:

1. Waiting for user command
2. Working
3. Blocked

Sessions report their state to the parent task.

## Progress Window

A window listing all task names. Located on the left side of the screen.

### Behavior

- Clicking a task switches to it and displays all its sessions.
- Each task name shows a status icon on the left (Version 2+):
  1. Waiting for user command
  2. Working
  3. Blocked
- Task state is derived from aggregating its sessions' states.

### Controls

- **New Task** button at the top of the window.
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

## Versioning

### Version 1

- Tasks, sessions, and progress window.
- Terminal session type.
- No session or task state indicators.

### Version 2

- Session state evaluation and display.
- Task state derived from session states.
- Status icons in progress window and session tabs.

### Version 3

- New session type: Jenkins Pipeline Viewer.
- Connects to Jenkins to display pipeline progression.
- Reports pipeline state back to the task.
