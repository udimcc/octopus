# Check for Updates - Design

**Date:** 2026-11-09
**Goal:** Octopus finds new releases by itself, and the user can install one from inside Octopus. Octopus then restarts on the new version.

## Product decisions

| Topic | Decision |
|---|---|
| Release source | Release dirs `/mnt/scratch/octopus/octopus-X.Y.Z/`, published by extracting under `/mnt/scratch/octopus/.incoming/` then `mv` (atomic same-fs rename; dot-dirs are ignored by the parser), with the same layout as `release/<v>/octopus-<v>/`. The default dir can be overridden by a hidden `updates.dir` key in `settings.json` (no UI). |
| What counts as a new version | A strictly greater semver than the running `app.getVersion()`. Equal, older and malformed names (`octopus-1.2`, `octopus-v1.2.0`, `octopus-1.2.0-rc1`, `foo-1.2.0`) are ignored. A dir only counts if it contains `install.sh` and `linux-unpacked/octopus`. |
| When to check | At startup, then every hour. Checks never overlap. "Check now" reuses a check that is already running. |
| Unreachable folder | No popup. The Settings tab shows "Couldn't check: update folder unreachable". The last known available version and the badge are kept. |
| "New version" popup | Main window only. Buttons **Dismiss** and **Install**. |
| Dismiss | Persists `updates.dismissedVersion` in `settings.json`, so it survives restarts. The popup comes back only for a strictly newer version. The badge and Settings tab still show the update. |
| Not now | Closing the restart confirm without installing snoozes the popup for that version in the renderer only (not persisted, so it returns after a restart). The badge and Settings tab are unaffected. |
| Title badge | A small accent-colored download arrow next to "Octopus - X.Y.Z". Tooltip: "Update available: X.Y.Z". Clicking it opens Settings on the Check for updates tab. Hidden in read-only view windows. |
| Settings tab "Check for updates" | Shows the installed and available versions, the last-checked time, and an up-to-date, available or unreachable message. Has a **Check now** button and, when an update is available, an **Install** button. |
| Restart confirmation | "Octopus will restart after the install". Buttons **Not now** and **OK**. OK shows "Installing…" and the dialog can't be closed until the install finishes. |
| Busy sessions | OK counts as consent: the usual "busy sessions, quit anyway?" warning is skipped. |
| Install failure | The current install stays intact and the running app keeps running. The restart dialog shows the error. |
| Dev builds | Fully enabled, the same as packaged builds. An install replaces the installed app and relaunches the installed app, not the dev build. |

## Does Octopus need to be closed to install?

Today it does. `install.sh` deletes the program dir (`rm -rf`) and then copies, so it removes files a running Electron app may still open later.

The chosen approach removes that need. The new `install.sh` copies the payload fully into `octopus-app.new`. It then renames the live dir to `octopus-app.old`, renames `.new` to the live dir, and deletes `.old`. A Linux rename doesn't affect the inodes the running app holds, so Octopus keeps running during the whole copy. A failure before the swap leaves the old install untouched. After the swap, `app.relaunch()` starts the new binary from the same path. Manual installs get the same safety.

## Approaches considered

- **A: Stage-and-swap in the new release's `install.sh`, then relaunch (chosen).** The app stays up and shows progress. Errors show right away and no restart is needed. The new release's own install steps run (symlink, `.desktop`, icon). There is still one install path for both manual installs and updates.
- **B: A detached helper installs after Octopus exits.** Rejected. The app vanishes during the copy with no feedback, errors only show after relaunch, and the helper is hard to test.
- **C: The app copies the payload itself.** Rejected. It duplicates the desktop-integration logic in `install.sh` and ignores install changes in future releases.

## Architecture

- **The main process owns the update status:** up to date, available (with version), or unreachable, plus the last-checked time and the current version. The status is pushed to every window through the existing event stream.
- **Pure logic lives in `domain/`:** semver parsing and comparison, folder-name parsing, and picking the newest version.
- **The `UpdateSource` port** lists candidate release dirs, with a timeout so a hung mount counts as unreachable. It also stages a release into a local temp dir, so a flaky share can't break the install partway through. The filesystem adapter is wired only in the composition root.
- **The `check-for-updates` use case** builds the status, keeps the last known available version while the folder is unreachable, decides whether to show the popup based on `dismissedVersion`, and persists dismissals through the settings port.
- **The `install-update` use case** rejects concurrent installs. It stages to temp, runs the staged `install.sh` through the existing `ScriptRunner` port (argv only, with a timeout and captured stderr), and always cleans up temp. On exit 0 it asks the `AppRelauncher` to relaunch; on failure it returns the error with the stderr tail.
- **The relauncher (main process)** sets a skip-busy-warning flag, calls `app.relaunch` with the program dir's `octopus` launcher, and then quits. Daemon-backed shells (the default backend) keep running across the restart and re-attach.
- **The scheduler (main process)** runs the boot check and then the hourly check, broadcasts only when the status changes, and stops on quit.
- **IPC:** a new transport-agnostic `updates` group in `shared/ipc.ts` with get status, check now, dismiss and install. Install only accepts the version that is currently available.
- **Renderer:** a store slice seeded from get-status and updated by status events. Two new modals follow the shared overlay contract: shared overlay style, `role="dialog"` with `aria-modal`, every key stopped from propagating, and each modal listed in the `topmostModal()` doc comment. The title badge and the new Settings tab also read from the store.

## Compatibility notes

- From now on, `install.sh` is a compatibility surface. Every future release must keep it runnable non-interactively by an older Octopus, with the stage-and-swap semantics and a non-zero exit on failure.
- The release process gains a publish step: untar the release into `/mnt/scratch/octopus/`.
- DB compatibility is unchanged. Forward-only migrations and the refusal to open a newer DB still protect rollbacks.

## Testing strategy

- **Domain:** numeric ordering (1.10.0 > 1.9.0), equal and older not newer, all malformed names, and an empty list.
- **Filesystem adapter (temp dirs):** valid dirs are listed; dirs missing `install.sh` or the launcher are skipped; a missing root and a timed-out read both count as unreachable; staging and cleanup work.
- **Check use case (fake source and clock):**
  - up-to-date → available → up-to-date transitions
  - unreachable keeps the available version
  - after a dismiss, the popup comes back only for a newer version
  - a check already running is reused
- **Install use case (fake `ScriptRunner` and relauncher):**
  - success relaunches once with the right launcher path
  - a non-zero exit or a timeout returns an error and does not relaunch
  - a concurrent install is rejected
  - temp is cleaned up on every path
- **Scheduler (fake timers):** checks at boot and hourly, never overlaps, broadcasts after every completed check (`lastCheckedAt` changes) and on dismiss.
- **Settings:** round-trips the dismissed version and the dir override.
- **`install.sh` integration test (sandboxed `HOME`/`XDG_DATA_HOME`):**
  - a fresh install works
  - an upgrade leaves no `.new`/`.old`
  - an injected failure exits non-zero and leaves the old app intact
  - the symlink and `.desktop` file are correct
- **Renderer:** both modals (actions, installing and error states, the window `keydown` spy, main window only); the badge (presence, tooltip, click); each state of the Settings tab.
- **Manual end-to-end check:** relaunch is only checked manually. Put a fake newer release dir in a temp `updates.dir`, install with busy sessions, and confirm there is no warning, the app relaunches on the new version and the shells re-attach. The dev-build test needs a sandboxed `XDG_CONFIG_HOME` and `XDG_DATA_HOME` (or the installed app quit first), otherwise it collides with the installed app. Also confirm a broken `install.sh` shows an error while the old app keeps running.
