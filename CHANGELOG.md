# Changelog

All notable changes to Octopus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
