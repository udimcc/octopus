# Changelog

All notable changes to Octopus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0]

### Added

- **Durable terminal sessions that survive an app restart (`octopusd`).** Terminal PTYs are
  now hosted by a long-lived, detached `octopusd` daemon instead of the Electron main
  process. Restarting the app **re-attaches** to the still-running shells rather than
  respawning them, so the working directory, any live foreground program (Claude Code, vim,
  emacsclient), and scrollback are all preserved across the restart. Fixes the two reported
  bugs: cwd lost and live programs killed on restart.

### Changed

- **The daemon backend is now the default.** `terminal.backend` defaults to `'daemon'`; set
  it to `'in-process'` in `settings.json` to opt out. If the daemon can be neither reached
  nor launched, the app degrades to in-process (fresh shells at the last-known cwd), so
  rollback is a one-line setting flip.
- **DB schema v6.** Adds a `last_cwd` column to `sessions` (forward-only migration) so a
  fresh spawn can reopen at the terminal's last-known directory.

## [1.1.0]

### Added

- **Start a task from an existing worktree.** The New-Task dialog now has two tabs: *From
  New Worktree* (provision a fresh `git worktree`, as before) and *From Existing Worktree*
  (pick a directory Octopus already has checked out). Adoption detects the worktree's
  owning repository and current branch via git, so the task is delete-safe (the owning
  repo — never the worktree — is recorded as the deletion root). Picking a repository's
  main working tree is rejected with a clear message.

### Changed

- The New-Task *Source branch* field placeholder is now `master` (was `main`).

### Fixed

- **Restored `package.json` scripts and devDependencies.** The `1.0.0` release commit
  truncated `package.json`, dropping every `scripts` entry and all `devDependencies`,
  which broke `npm run dev`/`build`/`test`/`lint`. Both sections are restored.

## [1.0.0]

First released build. Delivered as a `tar.gz` with an `install.sh` (not an apt package);
see the **Releasing** section of `README.md`.

### Added

- **Tasks & sessions.** Run multiple development tasks in parallel, each owning an
  isolated git worktree and grouping one or more interactive terminal sessions.
- **Progress window + multi-window support.** A main progress panel plus secondary
  session windows; window placement is persisted and restored (off-screen-clamped).
- **Persistence.** Tasks, sessions, terminal scrollback, and window layout are stored in
  SQLite under the XDG data dir and restored on relaunch.
- **Release version display.** The window title shows the running version (e.g.
  `Octopus 1.0.0`); `window.octopusAPI.getVersion()` exposes it to the renderer.

### Changed

- Pinned the Linux launcher name to `octopus` (`electron-builder.yml`).

### Fixed

- **Rollback safety.** Opening a database written by a *newer* Octopus (after a version
  rollback on the shared data dir) now fails with a clear dialog instead of silently
  stamping the schema version down — which previously corrupted the next upgrade. A
  pre-migration backup (`octopus.db.bak-v<N>`) is written before any upgrade migration.
