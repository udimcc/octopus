# Check for Updates - Plan

**Feature**: Octopus checks a local releases folder at boot and then hourly. When it finds a newer release it shows a popup, a title badge and a Settings tab, and the user can install with one click: an atomic `install.sh` swap, then a relaunch that skips the busy-sessions warning.

Design: `docs/plans/check-for-updates_2026-11-09-design.md`

## Wave 1 (parallel)
### [x] Subject 1: Semver domain
**Files:** src/domain/semver.ts, src/domain/semver.test.ts

- [x] Pure strict `X.Y.Z` parser that returns null when the input is malformed. Add a compare function and an `isNewer(candidate, current)` helper (strictly greater).
- [x] Release-dir-name parser for `octopus-X.Y.Z`. It rejects `octopus-1.2`, `octopus-v1.2.0`, `octopus-1.2.0-rc1`, `foo-1.2.0` and the empty string.
- [x] Unit tests: numeric ordering (1.10.0 > 1.9.0), equal and older are not newer, every malformed case.

### [x] Subject 2: Update source port + fs adapter
**Files:** src/ports/update-source.ts, src/adapters/update/fs-update-source.ts, src/adapters/update/fs-update-source.test.ts

- [x] Port with three methods. `listCandidates(dir, timeoutMs)` returns `{name, path}` for subdirectories that contain both `install.sh` and `linux-unpacked/octopus`, or a typed "unreachable" result. `stageToTemp(releasePath)` copies the release to a local tmp dir and returns that path. `cleanup(tmpPath)`.
- [x] The port also defines `AppRelauncher` (`relaunch(execPath)`). The main process implements it.
- [x] Adapter: `readdir` raced against a timeout so a hung mount maps to unreachable. A missing root also maps to unreachable. The adapter does no version parsing.
- [x] Tests with tmp dirs: valid dirs are listed; dirs missing `install.sh` or missing the launcher are skipped; a missing root gives unreachable; a stubbed readdir that never resolves times out to unreachable; stage and cleanup copy and remove the tree.

### [x] Subject 3: Settings keys
**Files:** src/ports/settings-store.ts, src/adapters/settings/json-settings-store.ts, src/adapters/settings/json-settings-store.test.ts

- [x] Add `updates?: { dir?: string; dismissedVersion?: string }` to `Settings`/`SettingsPatch`. `dir` is a hidden key with no UI.
- [x] Make the adapter persist and merge the `updates` group without clobbering other keys.
- [x] Round-trip tests: write then read `dismissedVersion`; a hand-edited `updates.dir` is read back; when the key is absent the result is undefined.

### [x] Subject 4: Atomic install.sh
**Files:** install.sh, test/integration/install-script.integration.test.ts

- [x] Replace `rm -rf "$PROGRAM_DIR"` + `cp -a` with: stage into `octopus-app.new`, rename the live dir to `.old`, rename `.new` to live, then remove `.old`. Clean up a stale `.new`/`.old` from an earlier run. Exit non-zero on failure and leave the live dir untouched.
- [x] Integration test with a sandboxed `HOME`/`XDG_DATA_HOME` and a fake payload: a fresh install works; an upgrade replaces the payload and leaves no `.new`/`.old`; an injected copy failure exits non-zero and leaves the old app intact; the symlink and `.desktop` file are still correct.

### [x] Subject 5: IPC contract + preload
**Files:** src/shared/ipc.ts, src/shared/dto.ts, src/shared/events.ts, src/preload/index.ts

- [x] `UpdateStatusDTO`: `state: 'upToDate' | 'available' | 'unreachable'`, `availableVersion?` (kept while unreachable), `currentVersion`, `lastCheckedAt`, `dismissedVersion?`.
- [x] `updates` group on `OctopusAPI`: `getStatus`, `checkNow`, `dismiss(version)`, `install(version)`, which resolves `{ok: true} | {ok: false, error}`. Add the channel constants.
- [x] `updateStatusChanged` variant on the `EventDTO` union, delivered through the existing `onEvent` stream.
- [x] Implement the group in preload.

### [x] Subject 6: Quit-warning bypass
**Files:** src/main/window.ts, src/main/window.test.ts

- [x] Add an exported `skipBusyQuitWarning()` setter. When it has been called, the close and before-quit path skips `confirmQuitWhileBusy`.
- [x] Test: with busy sessions and the flag set, no dialog is shown and quit proceeds. Without the flag, behavior is unchanged.

## Wave 2 (depends on Wave 1)
### [x] Subject 7: check-for-updates use case
**Files:** src/application/use-cases/check-for-updates.ts, src/application/use-cases/check-for-updates.test.ts

- [x] Resolve the dir (`settings.updates.dir` or the default `/mnt/scratch/octopus`). Call `listCandidates`, parse with semver and keep the max that is strictly newer than the current version. Build the status with `lastCheckedAt` from the `Clock` port.
- [x] When the source is unreachable, set state `unreachable` and keep the last known `availableVersion`.
- [x] Single-flight: a call made while a check is running returns the same promise.
- [x] `shouldPopup(status)` = available && (no dismissedVersion || available > dismissedVersion). `dismiss(version)` persists through the settings store.
- [x] Tests with a fake source and clock (reuse `src/application/use-cases/test-fakes.ts`): upToDate→available→upToDate transitions; unreachable keeps available; a newer release after a dismiss pops up again; equal/older are ignored; concurrent calls hit the source once.

### [x] Subject 8: install-update use case
**Files:** src/application/use-cases/install-update.ts, src/application/use-cases/install-update.test.ts

- [x] Reject the call if an install is already in progress.
- [x] Stage the release to tmp, then run `sh <tmp>/install.sh` (argv, no shell string) through `ScriptRunner` with `timeoutMs` and cwd set to the tmp dir.
- [x] On exit 0: call `AppRelauncher.relaunch(<programDir>/octopus)` and return ok. On non-zero exit or timeout: return an error carrying the stderr tail and do not relaunch. Always clean up tmp.
- [x] Get the program dir from an injected value (the composition root resolves `XDG_DATA_HOME`).
- [x] Tests with a fake ScriptRunner and a fake relauncher: success relaunches once with the right execPath; non-zero exit gives an error with stderr and no relaunch; timeout gives an error and no relaunch; a concurrent call is rejected; tmp is cleaned on every path.

### [x] Subject 9: Renderer update store
**Files:** src/renderer/src/store/update-status.ts, src/renderer/src/store/update-status.test.ts, src/renderer/src/store/store.ts

- [x] Store slice for the status: seeded from `updates.getStatus()` and updated from `updateStatusChanged` events. Add `restartConfirmOpen` with open/close, and install state (idle / installing / error message).
- [x] Extend `openSettings` to take an optional tab id (`'updates'`).
- [x] Selector `showUpdatePopup`, computed as main window (`windowRole`) && available > dismissedVersion.
- [x] Tests: seed plus event updates; popup gating by role and by dismissedVersion; install state transitions.

## Wave 3 (depends on Wave 2)
### [x] Subject 10: Main wiring + scheduler
**Files:** src/main/update-scheduler.ts, src/main/update-scheduler.test.ts, src/main/composition-root.ts, src/main/ipc-handlers.ts, src/main/ipc-handlers.test.ts, src/main/index.ts

- [x] Scheduler: run a check at boot, then every hour. Skip a tick if a check is in flight. `checkNow` reuses the in-flight check. Broadcast to all windows only when the status changes. Provide `stop()`.
- [x] Composition root: create `FsUpdateSource`, both use cases (with the existing `scriptRunner` and `settings`) and the relauncher. The relauncher calls `skipBusyQuitWarning()`, then `app.relaunch({execPath})`, then `app.quit()`.
- [x] IPC handlers for `updates.*`. `dismiss` re-broadcasts the status. `install` validates that the version equals the current available version.
- [x] index.ts: start the scheduler after the windows are up; stop it on quit.
- [x] Tests: scheduler with fake timers (boot check, hourly tick, no overlap, broadcast on change only); IPC routing and install-version validation.

### [x] Subject 11: Update modals
**Files:** src/renderer/src/components/UpdateAvailableModal.tsx, src/renderer/src/components/UpdateAvailableModal.test.tsx, src/renderer/src/components/RestartConfirmModal.tsx, src/renderer/src/components/RestartConfirmModal.test.tsx, src/renderer/src/components/IssuesDrawer.tsx, src/renderer/src/App.tsx

- [x] `UpdateAvailableModal`: shows the version. 'Dismiss' calls `updates.dismiss`; 'Install' opens the restart confirm.
- [x] `RestartConfirmModal`: text 'Octopus will restart after the install', buttons 'Not now'/'OK'. 'OK' calls `updates.install`, shows "Installing…" with the buttons disabled, and shows the error on failure.
- [x] Both follow the overlay rule: `overlayStyle`, `role="dialog"`, `aria-modal`, `tabIndex={-1}`, `stopPropagation` on every key, Escape closes. Neither may close while an install is running.
- [x] Mount both in App's main-window branch, after ProgressPanel in DOM order so the restart confirm stacks above SettingsModal. Add both to the `topmostModal()` doc comment.
- [x] Tests: button actions, installing and error states, the window `keydown` spy (keys never reach the window), and the popup not rendering in secondary or view windows.

### [x] Subject 12: Badge + Settings tab
**Files:** src/renderer/src/components/ProgressPanel.tsx, src/renderer/src/components/ProgressPanel.test.tsx, src/renderer/src/components/SettingsModal.tsx, src/renderer/src/components/SettingsModal.test.tsx

- [x] Download-arrow badge next to the 'Octopus - X.Y.Z' title, shown only when an update is available. Tooltip 'Update available: X'. Clicking it calls `openSettings('updates')`. Hide it in `readOnly`/view mode.
- [x] New 'Check for updates' entry in `CategoryId` and the tab list. The tab shows the installed and available versions, the last-checked time, and an up-to-date, available or unreachable message. 'Check now' is disabled while a check runs. 'Install' opens the restart confirm.
- [x] Respect the initial-tab argument.
- [x] Tests: badge presence, tooltip and click; each tab state (upToDate, available, unreachable with a stale available version); 'Check now' calls the API; 'Install' opens the confirm.

## Wave 4 (depends on Wave 3)
### [x] Subject 13: Docs
**Files:** CLAUDE.md, CHANGELOG.md

- [x] CLAUDE.md Releasing section: publish by untarring to `/mnt/scratch/octopus/octopus-X.Y.Z/`. Document the `updates.dir` override, the atomic `.new`/`.old` swap in install.sh (replacing the "replace-in-place" wording), in-app self-update with daemon shells surviving the restart, and the rule that `install.sh` is now a compatibility surface.
- [x] CHANGELOG entry for self-update and the safer install.sh.

## Testing

- [x] `npm run lint` passes with no boundary violations: only composition-root imports `adapters/update`, and the renderer uses only `window.octopusAPI`.
- [x] `npm run typecheck` passes for both the node and web projects.
- [x] `npm run test` passes in both Vitest projects, including the new install-script integration test.
- [x] Every new modal has a passing window `keydown` spy test and is listed in the `topmostModal()` doc comment.
- [ ] Manual e2e: a fake `octopus-<newer>` dir under a temp `updates.dir` makes the popup appear in the main window only.
- [ ] Manual e2e: after a Dismiss the popup does not reappear for that version, and a higher version brings it back.
- [ ] Manual e2e: with a bad or unmounted dir, Settings shows unreachable, the badge persists and no popup appears.
- [ ] Manual e2e: installing with busy sessions shows no quit warning, the app relaunches on the new version and daemon shells re-attach.
- [ ] Manual e2e: a broken `install.sh` shows an error in the restart modal and the old app keeps running.

## Acceptance Criteria
- A strictly newer `octopus-X.Y.Z` dir that contains `install.sh` and `linux-unpacked/octopus` is detected at boot and within 1h. Malformed, equal or older dirs are ignored.
- The status (upToDate / available / unreachable, lastCheckedAt, current version) is owned by main and pushed to all windows. Checks never overlap, and 'Check now' reuses an in-flight check.
- An unreachable dir sets status `unreachable`, keeps the last known available version and never pops up.
- The popup shows only in the main window, and only when the available version is greater than the persisted `updates.dismissedVersion`. Dismiss persists.
- The title badge, its tooltip, its click-to-Settings behavior and the Settings tab all reflect the status.
- Install runs the staged `install.sh` with a timeout and rejects concurrent installs. On success the app relaunches from the program dir with no busy-sessions prompt, and daemon shells survive. On failure the old app keeps running and the error shows in the modal.
- An install.sh upgrade is atomic (no leftover `.new`/`.old`), and a failed install leaves the previous install intact.
- Dev builds behave the same as packaged builds. CLAUDE.md and CHANGELOG are updated.
