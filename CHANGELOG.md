# Changelog

All notable changes to Octopus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **App icon and Linux launcher entry.** Octopus now ships its own icon (rendered from
  `src/renderer/src/assets/octopus.svg` by `npm run render:icon`) for the window/taskbar and
  for `install.sh`'s desktop integration: a `~/.local/share/applications/octopus.desktop`
  entry plus a `~/.local/share/icons/hicolor/512x512/apps/octopus.png` icon, so Octopus shows
  up in the desktop environment's app launcher after install. `uninstall.sh` removes both.
- **"+" new-session button after the last tab.** The tab bar's "+ Session" button now sits
  right after the last session tab, so a new tab opens where the button was. Once a task has
  tabs it shrinks to a compact "+", and it stays visible at the right edge when tabs overflow.
- **Issues drawer close button.** A "✕" at the left of the drawer header closes it, like
  Escape (unsaved edits still prompt first).

## [1.0.0]

Adds Issues (a list and a Kanban board, with read-only Jira import), split panes, window
views pinned to one task, and defined projects in the New-Task modal. Claude status is
now decided by Octopus from a hook event log, which fixes many status edge cases.

### Added

- **Issues.** Track work items inside Octopus: a name, a markdown description, an optional project, and
  a status (Todo, In progress, In review, Done). Open the Issues drawer from the button at the bottom
  left of the Progress window, below the task list, or with **Alt+Shift+I** (configurable in Settings →
  Keybindings); it slides in from the right over the session area and lists issues grouped by status,
  newest first. An issue can be bound 1:1 to a task — from the issue view ("Link task" / "Create
  task") or from the New-Task modal's issue picker — which moves a Todo issue to In progress; unbinding
  never changes the status. Deleting a bound task or issue offers "Delete task only", "Delete issue
  only", "Delete both" or "Cancel"; a bound task shows its issue's status icon, with the issue name on
  hover. Links in a description open in the system browser (http/https only); nothing else navigates the
  app window. Stored locally in a new `issues` table (schema v8) — upgrading writes an
  `octopus.db.bak-v7` backup first, and an older build refuses to open the upgraded database rather than
  risk corrupting it.
- **Issues board.** The Issues drawer has **List** and **Board** tabs. The Board shows four columns —
  Todo, In progress, In review, Done — always expanded, newest first, each with a count and its own
  scroll; cards show the name, the project and the linked task. Drag a card to another column to change
  its status, exactly like the status dropdown (no prompts, the linked task is untouched); dropping on
  the same column or outside does nothing, and Esc or closing the drawer cancels a drag. Both tabs
  share one selection, so switching keeps the open issue and any unsaved edits without a prompt. The
  drawer reopens on the last-used tab (List after a restart), and a task's issue icon opens it there
  with the issue scrolled into view, expanding a collapsed group on List. **+ New Issue** sits at the
  left of the header row, followed by the tabs, and the issue view takes a fixed share of the
  drawer (about 61%, the same on both tabs); the list or board fills the rest.
- **Defined projects in the New-Task modal.** A left Projects sidebar on the "From New
  Worktree" and "From Existing Repo" tabs replaces the per-task directory picker. "+ Add
  project" opens the folder picker once per repo — a linked worktree resolves to its
  main checkout, and picking a repo you've already added just selects it; default
  branches are editable inline, and a project can be removed once no task uses it
  anymore. "From New Worktree" fills in the task's repo path (plus an auto-detected
  default branch) from the picked project. "From Existing Repo" now picks a worktree
  from the project's own `git worktree list` (its main checkout or a linked worktree)
  instead of browsing to any directory — listed under "Available", then "Used" (in use by
  another task, disabled; an empty section is hidden) — so it can only adopt a worktree that belongs to a configured project.
  The first launch after upgrading seeds one project per repository already in use by an
  existing task, so an existing setup starts with a populated list instead of an empty
  one.
- **Split panes (groups).** A window can show several sessions of the same task side by side
  or stacked, tmux-style, as a **group**: a fixed combination you build on purpose
  that stays together no matter which of its sessions you're focused on or where else you
  work. `Ctrl+Shift+E` splits the focused pane to the right and `Ctrl+Shift+O` splits it
  downward, each with a new terminal already joined. A tab's right-click menu can also put
  that existing session into the focused pane's group ("Split right" / "Split down"), or take
  it back out ("Remove from group"). Click a pane or use `Ctrl+Shift+H/J/K/L` to move focus —
  switching tabs only ever moves which pane you're looking at, never changes a group. Each
  group gets a colored line across its tabs; drag that line to reorder the whole group, or
  drag it out to move the group to another window — every member moves together. Right-click
  the line to ungroup. Drag the gap between panes to resize. A group dissolves automatically
  when it would drop to one member. A pane can't be split below about 20 columns × 5 rows.
  Only the focused pane counts as "being looked at", so a side pane still gets the
  ready-for-review dot and the state-change toast. The database schema moves to version 9
  (backed up before migrating); an older build refuses to open it with a dialog rather than
  corrupting it (see "Rollback safety").
- **Focus flash on the session tab.** When a window gains focus (the session shortcut
  walking into another window, a mouse click into it, or Alt+Tab), its marked tab fades
  from a strong accent tint to the normal active-tab background over 1 second, to show
  which session is now focused. Switching tabs within a window doesn't flash, and neither
  does a window's first appearance or a system with reduced motion enabled.
- **Jira import.** A "Fetch from Jira" button in the Issues drawer header opens a modal that searches
  Jira (via the internal LiteLLM gateway, a cache that refreshes every few hours) by project, assignee,
  issue key, days and sprint, with the last-used filters remembered. Each result is matched against
  existing issues by Jira key and shown as New, Duplicate ("Duplicated by <name>") or Conflict
  ("Conflicts with <name>") — only New rows are importable, and a deleted import frees its key for next
  time. Clicking a row shows its full description and Definition of Done rendered as markdown. An
  imported issue is named "KEY: Summary", starts as Todo with no project, and carries a new read-only
  **Source** (Jira or Local) shown as a badge in the issue list and a line in the issue detail; the Jira
  status itself is never imported, and a later local edit shows as a Conflict on the next fetch. The
  Jira API key is entered once in Settings as a password field and is never shown again, never leaves
  the main process, and is encrypted at rest (Electron `safeStorage`, mode 0600) in a new `credentials/`
  directory alongside the database — never in the database or `settings.json`. Stored locally via a new
  `source`/`jira_key` pair of columns on `issues` (schema v10) — upgrading writes an `octopus.db.bak-v9`
  backup first, and an older build refuses to open the upgraded database rather than risk corrupting it.
- **Window views.** Right-click a task → "+ New Window From Task" opens a window pinned to that task
  (one per task). The task's sessions move into it, and session walk, moves and drag-and-drop stay
  inside that window and its secondary windows. Main shows a "Viewing in window" badge for the task.
  Closing the view returns its sessions to main and switches main to the task. Views are restored on
  relaunch. Schema v11 rebuilds the `windows` table — upgrading writes an `octopus.db.bak-v10`
  backup first. Relaunching Octopus now raises the main window instead of starting a second instance.

### Changed

- **New-task branch names use underscores.** The new-branch field is still filled
  from the task name as you type, but words are now joined with `_` instead of `-`
  (`Add Feature 1` → `add_feature_1`; `feature/…` namespaces are kept). The field
  stays editable. Worktree folder names are unchanged.
- **Working status icon is a yellow spinner.** A session or task that is working now shows a rotating
  yellow part-circle ("thinking") instead of a pulsing blue dot. All session and task status icons
  are 30% larger.

### Fixed

- **Claude status went "done" while a background agent was still running.** With two
  background agents, the first one finishing turned the session Idle while the second
  still ran. The session now stays Working while any background agent runs.
- **Claude status flickered done-then-working when a background agent returned.** Between
  an agent finishing and Claude picking up its result, the session briefly read Idle, which
  raised a false notification. The session now stays Working across that hand-off. If
  Claude never picks up the result, the session goes Idle after about 10 seconds.
- **A denied permission or an Esc left the session on Needs input / Working.** Neither
  fires a Claude hook; Octopus now reads them from Claude's transcript and shows Idle.
- **A new terminal could show the status of a Claude from before the restart.** A freshly
  started terminal now has no status until a Claude in it reports. A terminal re-attached
  from the daemon still recovers its live status, including running agents.
- **A `claude -p` run from inside a session changed that session's status.** Hooks of a
  Claude nested inside the session's own Claude are now ignored.
- **With two windows, only one of them showed a marked session.** Walking from a tab in
  one window to a tab in another with the session shortcut left the first window with no
  marked tab, and it switched to showing its first session. Each window now keeps its own
  marked session per task and keeps showing it when focus moves away. The focused session
  is the marked tab of the focused window. The session shortcuts start from it, and it is
  what's restored after a restart. Moving a session to another window marks it there; if
  it was the source window's marked tab, the source falls back to the neighbouring tab.
  Closing a window's marked tab falls back to the window's last tab.
- **Scrollback lost when reopening the app.** A restored session's first event is the
  daemon's whole-buffer replay; both pre-hydration queues (main's per-window queue and
  the renderer's pre-mount buffer) counted *events* and dropped the oldest on overflow,
  so live output arriving before the terminal mounted evicted exactly the replayed
  history they existed to deliver. Both now hold output per session as a byte-bounded
  tail, so no volume of live output can push the history out.
- **A re-attached session showing nothing until you press a key.** Programs that redraw
  on demand (Claude Code, TUIs) had nothing to redraw *for* after a re-attach: the pane's
  mount-time resize matched the size the PTY already had, and the kernel suppresses
  `SIGWINCH` when the window size is unchanged. The first resize after a re-attach is now
  bracketed (off-by-one row, then the real size ~50 ms later) so the foreground program
  gets a real `SIGWINCH` and repaints itself.
- **A re-attached full-screen program left in the wrong terminal modes.** A program's
  one-time terminal setup (bracketed paste, alternate screen, keypad, mouse reporting)
  scrolls out of the replay buffer long before a days-old session is re-attached, so
  `emacsclient -nw` and friends came back with the emulator in the wrong modes — Enter
  printed gibberish and `reset` was the only way out. The daemon now tracks the sticky
  DEC private modes for each PTY's whole life and re-asserts them after the replay (the
  screen switch last, so the history still lands in the normal buffer).
- **Stale login-session environment in shells spawned after a logout.** `octopusd`
  deliberately outlives login sessions and built each child's env from its own, so a
  daemon started before a logout kept handing out the dead session's `DISPLAY`,
  `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `SSH_AUTH_SOCK`. Those vars are now
  overridden per spawn from the app's (current) environment. Already-running shells keep
  the env they were forked with — a process's environment cannot be rewritten.
- **A broken settings.json could be silently destroyed by the next save.**
  `JsonSettingsStore.save()` now re-reads the file on disk right before writing: if
  what's there isn't valid JSON or isn't an object, it's copied to
  `settings.json.corrupt-<epoch-ms>` and a warning is logged before the new settings
  overwrite it. This runs ahead of every write path — the boot project seed, add/remove
  project, a default-branch edit, and a plain settings-pane save — so a hand edit broken
  by a typo is never destroyed outright.
- **`terminal.stateDetection`/`terminal.injectClaudeHooks` settings were silently
  dropped, so neither opt-out ever took effect.** A hand-set value for either in
  `settings.json` was discarded on every parse, and any save deleted both keys from the
  file outright — `mergeSettings` read every other `terminal` setting but not these two.
  Unchecking "Detect session status" in Settings now actually takes effect: newly
  created bash/zsh sessions launch as a plain login shell (no OSC 133 rcfile). Claude-session
  status is unaffected by it — that is controlled by `terminal.injectClaudeHooks`. `terminal.injectClaudeHooks` (hand-set in
  `settings.json`; there's no Settings-pane toggle for it) now likewise takes effect
  when set to `false`: Octopus's hook config is no longer merged into Claude's own
  settings at boot, and the Claude-state watcher doesn't start.
- **Cycling tasks quickly flickered.** Switching A→B→C in quick succession briefly showed C, then B,
  then C again. Late echoes of this window's own earlier switches are now ignored.

### Changed

- **Claude status is now decided by Octopus, not by the hook script.** The python script
  wired into Claude's hooks now only records each hook to a per-session log
  (`claude-state/<session>.events.jsonl`); Octopus folds that log into the status. The
  statusline is a pure pass-through to your own statusline command again.
- **`AskUserQuestion` shows Needs input**, like a permission request.
- **Quitting Claude clears the session's icon** (no status), instead of leaving it Idle.
- **Needs input wins over running background agents**, so a permission prompt is never
  hidden behind Working.
- **The `Notification` hook is no longer installed.** Octopus removes its old entry from
  `~/.claude/settings.json` on startup; your own `Notification` hooks are kept. Old
  per-session state files (`*.json`, `*.lock`) are deleted.

## [0.2.0]

Adds live per-session status for Claude Code sessions and the surrounding
status/notification system, plus cross-window session navigation.

### Added

- **Live Claude session status.** Each session shows whether Claude is Idle, Working,
  or Needs input, rolled up to the owning task. Detection is Claude-only, driven by an
  out-of-band `python3` bridge (hooks + statusline) that writes a per-session state
  file the app watches — no polling of the terminal. The whole session stays *Working*
  while Claude delegates to background sub-agents.
- **Ready-for-review cue.** A session whose turn finished off-screen raises a
  ready-for-review dot so finished work is easy to spot; it clears once you've seen the
  turn finish or focus the session/task.
- **In-app status-change notification.** A toast announces when a session changes state
  (§9.5.1), suppressed for the session you're already looking at.
- **Cross-window session navigation.** `Ctrl+Shift+Arrow` cycles sessions in visual
  order, honoring Grouped vs Flat view and crossing between windows; a freshly opened
  terminal is focused on mount.

### Changed

- The working-status dot is now blue instead of teal.

### Fixed

- **State-detection edges.** Hardened Claude transcript-state inference against
  mid-tool and sub-agent boundaries: `/clear` no longer shows a session as Working, an
  idle `Notification` no longer reads as Needs input, `SubagentStop` maps back to
  Working, and a background sub-agent no longer flashes Idle on a session's 2nd+
  delegating turn.
- **Ready-for-review correctness.** The dot no longer masks a still-working session,
  clears on task/session focus, honors "if I saw it finish, no cue" at display time,
  and clears globally when a secondary-window turn finishes in place.
- Fixed cross-window session switching and terminal auto-name reuse.

## [0.1.0]

First released build. Delivered as a `tar.gz` with an `install.sh` (not an apt package);
see the **Releasing** section of `README.md`.

### Added

- **Tasks & sessions.** Run multiple development tasks in parallel, each owning an
  isolated git worktree and grouping one or more interactive terminal sessions.
- **Start a task from an existing worktree.** The New-Task dialog has two tabs: *From New
  Worktree* (provision a fresh `git worktree`) and *From Existing Worktree* (pick a
  directory Octopus already has checked out). Adoption detects the worktree's owning
  repository and current branch via git, so the task is delete-safe (the owning repo —
  never the worktree — is recorded as the deletion root). Picking a repository's main
  working tree is rejected with a clear message.
- **Progress window + multi-window support.** A main progress panel plus secondary
  session windows; window placement is persisted and restored (off-screen-clamped).
- **Durable terminal sessions that survive an app restart (`octopusd`).** Terminal PTYs
  are hosted by a long-lived, detached `octopusd` daemon instead of the Electron main
  process. Restarting the app **re-attaches** to the still-running shells rather than
  respawning them, so the working directory, any live foreground program (Claude Code,
  vim, emacsclient), and scrollback are all preserved across the restart. The daemon
  backend is the default; `terminal.backend` can be set to `'in-process'` in
  `settings.json` to opt out, and if the daemon can be neither reached nor launched the
  app degrades to in-process (fresh shells at the last-known cwd).
- **Persistence.** Tasks, sessions, terminal scrollback, and window layout are stored in
  SQLite under the XDG data dir and restored on relaunch.
- **Release version display.** The window title shows the running version (e.g.
  `Octopus 0.1.0`); `window.octopusAPI.getVersion()` exposes it to the renderer.

### Changed

- Pinned the Linux launcher name to `octopus` (`electron-builder.yml`).
- The New-Task *Source branch* field placeholder is `master`.

### Fixed

- **Rollback safety.** Opening a database written by a *newer* Octopus (after a version
  rollback on the shared data dir) fails with a clear dialog instead of silently stamping
  the schema version down — which would corrupt the next upgrade. A pre-migration backup
  (`octopus.db.bak-v<N>`) is written before any upgrade migration.
