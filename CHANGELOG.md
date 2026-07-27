# Changelog

All notable changes to Octopus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
