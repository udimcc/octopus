/**
 * Electron main-process entry point (§6.3, §6.7). Enforces the single-instance
 * lock, builds the composition root once, then restores the MAIN window, each
 * persisted VIEW window (window-view feature — one per task, restored before its
 * secondaries) and each persisted SECONDARY window (all at off-screen-clamped
 * bounds), and wires the graceful-quit hook. All backend wiring lives in
 * `composition-root.ts`; window/lifecycle plumbing in `window.ts`.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, screen, BrowserWindow, Menu } from 'electron'
import { bootstrap, findWindow, raiseWindow, type AppContext } from './composition-root'
import {
  createWindow,
  closeWindowProgrammatically,
  registerQuitHandler,
  optionsFromRecord
} from './window'
import { clampToDisplays, type Rect } from './window-bounds'
import { MAIN_WINDOW_ID } from '../domain/ids'
import type { WindowId } from '../domain/ids'
import type { CreateWindowOptions } from './window'
import { currentAppPaths } from '../adapters/env/paths'

// Dev-build lock isolation: `requestSingleInstanceLock` keys off `userData`
// (default `~/.config/octopus`, shared by every build), so a dev run
// (`npm run dev`) silently loses the race to an already-running INSTALLED
// Octopus and exits — the user ends up developing Octopus from inside Octopus.
// Repoint `userData` at something keyed on the resolved DATA dir (the pure
// resolver in `adapters/env/paths.ts`) BEFORE the lock below: the lock then
// follows the actual shared resource (the SQLite file), not the build. Two dev
// instances (or two installed instances) on the SAME data dir are still
// single-instance; a dev build with its own `XDG_DATA_HOME` runs alongside the
// installed app. Packaged builds are unaffected (`isPackaged` is false only for
// `electron .`/`electron-vite dev`).
if (!app.isPackaged) {
  const devUserData = join(currentAppPaths().dataDir, 'electron-dev')
  mkdirSync(devUserData, { recursive: true }) // setPath requires an existing dir
  app.setPath('userData', devUserData)
}

// Single-instance lock (DESIGN "Window View"): FIRST thing in the process, before
// the WebGL switch and well before `bootstrap()` opens the DB/daemon. A second
// `octopus` launch while one is already running must not open a second process
// against the same SQLite file/data dir — it should just focus the existing main
// window (handled by the `second-instance` listener registered below, once `ctx`
// exists). `requestSingleInstanceLock` is safe to call before `app.whenReady()`.
// On failure we call `app.quit()` (as Electron's own docs recommend) AND
// `process.exit(0)` — `quit()` only starts an async teardown of windows that don't
// exist yet; without the synchronous exit, every statement below (notably
// `bootstrap()`'s DB open) would still run in this doomed second process.
if (!app.requestSingleInstanceLock()) {
  console.error('[octopus] another instance already holds the lock for this data dir; exiting')
  app.quit()
  process.exit(0)
}

// On a GPU-less display (e.g. a VMware Horizon VDI) Chromium's WebGL falls back to
// SwiftShader (software). We deliberately probe WebGL once at startup to detect
// this and demote terminals to xterm's DOM renderer (DESIGN §5.3), but creating
// that probe context otherwise makes the GPU process log a scary ERROR (a
// "deprecated software-WebGL fallback" warning, or `kFatalFailure` under
// fail-on-caveat). This switch — the one Chromium itself names in that message —
// opts into software WebGL explicitly so the probe (and any future WebGL surface)
// runs quietly. It's a no-op on a real GPU. Must be set before `app` is ready.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

// Prepare the runtime environment and wire adapters before any window opens.
// A failure here (most notably an IncompatibleDbError — a DB written by a newer
// Octopus after a version rollback, §6.3) is fatal and unrecoverable: there is no
// window yet, so show a native error box (works before `app.whenReady`) and exit
// non-zero rather than crashing with an unhandled exception and no explanation.
let ctx: AppContext
try {
  ctx = bootstrap()
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[octopus] startup failed: ${message}`)
  dialog.showErrorBox('Octopus cannot start', message)
  app.exit(1)
  throw err // unreachable after app.exit; satisfies definite-assignment for `ctx`
}
registerQuitHandler(ctx)

// A second `octopus` launch lost the race for the lock above and already exited;
// this fires in THIS (the surviving) process. Relaunching while already running
// just focuses the existing main window (window-view feature) — it does not open
// a view or secondary, matching "Relaunching Octopus while running just focuses
// the main window."
// Boot opens main only after the (up to seconds-long) daemon warmup. A relaunch in
// that gap must NOT open main itself — boot would then open a second MAIN window —
// so it just asks boot to raise main once it opens.
let bootOpenedMain = false
let raiseMainAfterBoot = false

app.on('second-instance', () => {
  if (!bootOpenedMain) {
    raiseMainAfterBoot = true
    return
  }
  const win = findWindow(ctx.windowIds, MAIN_WINDOW_ID)
  if (win) {
    raiseWindow(win)
    return
  }
  // Main can be gone while the process is still alive — e.g. its close triggered
  // `app.quit()` (window.ts's `wireCloseSemantics`) but `confirmQuitWhileBusy`'s
  // dialog was cancelled, leaving `isQuitting` unset and no windows open. Re-open
  // it from its persisted record (same as boot/the macOS `activate` fallback)
  // before raising it, so relaunching always recovers a usable window.
  const mainRecord = ctx.deps.persistence.loadWindows().find((w) => w.id === MAIN_WINDOW_ID)
  restoreWindow(
    mainRecord
      ? optionsFromRecord(mainRecord)
      : { windowId: MAIN_WINDOW_ID, role: 'main', bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  )
  const reopened = findWindow(ctx.windowIds, MAIN_WINDOW_ID)
  if (reopened) {
    raiseWindow(reopened)
  }
})

/** Open one window and record its webContents.id → WindowId for hit-testing (§6.7). */
function openWindow(opts: CreateWindowOptions): void {
  const win = createWindow(ctx, opts)
  const wcId = win.webContents.id // capture now, while the window is alive
  ctx.windowIds.set(wcId, opts.windowId)
  win.on('closed', () => ctx.windowIds.delete(wcId))
}

/** Restore a persisted window at bounds clamped onto a currently-connected display. */
function restoreWindow(opts: CreateWindowOptions): void {
  if (!opts.bounds) {
    openWindow(opts)
    return
  }
  const displays: Rect[] = screen.getAllDisplays().map((d) => d.workArea)
  const clamped = clampToDisplays(
    {
      x: opts.bounds.x ?? 0,
      y: opts.bounds.y ?? 0,
      width: opts.bounds.width,
      height: opts.bounds.height
    },
    displays
  )
  openWindow({ ...opts, bounds: clamped })
}

void app.whenReady().then(async () => {
  // Remove Electron's default application menu bar (File/Edit/View/Window/Help).
  // Octopus has no use for it; the app is driven entirely through the renderer UI.
  Menu.setApplicationMenu(null)

  // Daemon warmup BEFORE any window opens (§6.2): if the durable backend is enabled
  // and reachable, this swaps `deps.sessions` to it and seeds the re-attach roster,
  // so the first `switchTask`-driven `startTaskSessions` already sees the settled
  // backend and re-attaches live shells instead of spawning fresh. A no-op on the
  // in-process path or if the daemon is unavailable (degrade-to-in-process).
  await ctx.warmupSessions()

  // `octopus-cli` control socket (control socket design). Listens only after the
  // single-instance lock (top of file) so a losing second instance never touches
  // the winner's socket. A bind failure is non-fatal: the app runs, the CLI just
  // reports "Octopus is not running".
  ctx.controlServer.listen().then(
    () => console.log(`[octopus] control socket listening at ${ctx.paths.controlSocketPath}`),
    (err: unknown) => console.error('[octopus] control socket unavailable; CLI disabled:', err)
  )

  const records = ctx.deps.persistence.loadWindows()

  // Main window first (it owns the progress panel). Fall back to a default record
  // if somehow absent (composition-root seeds it, so this is belt-and-suspenders).
  const mainRecord = records.find((w) => w.id === MAIN_WINDOW_ID)
  restoreWindow(
    mainRecord
      ? optionsFromRecord(mainRecord)
      : { windowId: MAIN_WINDOW_ID, role: 'main', bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  )
  bootOpenedMain = true

  // Then each persisted VIEW window (window-view feature), each pinned to one task,
  // before secondaries — a view's own secondaries should see their parent already
  // open. `pruneStaleViews` (composition-root, step 4d) already dropped any view
  // (and its secondaries) whose task didn't survive hydration; this re-checks
  // against the live `Workspace` anyway as a defensive second layer — a view
  // record slipping past that for any reason must never show an un-switchable
  // window pinned to a task that doesn't exist.
  const liveTaskIds = new Set(ctx.deps.workspace.tasks().map((t) => t.id))
  for (const record of records) {
    if (record.role === 'view') {
      if (record.taskId === undefined || !liveTaskIds.has(record.taskId)) {
        continue
      }
      restoreWindow(optionsFromRecord(record))
      // The in-process backend only spawns PTYs via `startTaskSessions` (daemon
      // warmup, `switchTask`); a restored view's sessions otherwise never start.
      // Dispatch it directly (NOT `switchTask`, which would move main's active-task
      // pointer) — idempotent, only `Created` sessions start (same pattern as the
      // daemon-warmup re-attach loop above, composition-root.ts).
      void ctx.commandLoop.dispatch({ kind: 'startTaskSessions', input: { taskId: record.taskId } })
    }
  }

  // Then each persisted secondary window at its restored (clamped) placement.
  for (const record of records) {
    if (record.role === 'secondary') {
      restoreWindow(optionsFromRecord(record))
    }
  }

  // A relaunch during warmup asked for main; raise it now that every window is up.
  if (raiseMainAfterBoot) {
    const main = findWindow(ctx.windowIds, MAIN_WINDOW_ID)
    if (main) raiseWindow(main)
  }

  // Windows are up: start the boot + hourly update check (status is pushed to windows).
  ctx.updateScheduler.start()
  // 'will-quit', not 'before-quit': before-quit can be cancelled and the app keep running.
  app.on('will-quit', () => ctx.updateScheduler.stop())

  // macOS: re-create the main window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const mainId: WindowId = MAIN_WINDOW_ID
      restoreWindow({
        windowId: mainId,
        role: 'main',
        bounds: { x: 0, y: 0, width: 1280, height: 800 }
      })
    }
  })
})

// V1.5 (§6.7): closing a SECONDARY window must NOT quit the app, so we no longer
// force-quit on `window-all-closed`. The app quits only when the MAIN window closes
// (wired in window.ts → app.quit()) or via an explicit Cmd/Ctrl+Q. On non-macOS
// this means the app stays alive with zero windows only in the transient moment
// between a secondary close and the main close; the main-close handler covers quit.
app.on('window-all-closed', () => {
  // Intentionally empty: quit is driven by the main window's close (§6.7).
})

// New secondary/view windows are created lazily in response to `windowCreated`
// events. The renderer dispatches `windows.create`/`views.create`; the command
// emits `windowCreated`; main opens the OS window here. A `role: 'main'` instance
// of this event never fires post-boot (there is exactly one, opened above).
ctx.bus.subscribe((event) => {
  if (event.type === 'windowCreated' && event.role === 'secondary') {
    openWindow({
      windowId: event.windowId,
      role: 'secondary',
      bounds: event.bounds,
      parentWindowId: event.parentWindowId
    })
  }
  if (event.type === 'windowCreated' && event.role === 'view' && event.taskId !== undefined) {
    openWindow({
      windowId: event.windowId,
      role: 'view',
      bounds: event.bounds,
      taskId: event.taskId
    })
    // Same as the boot-restore loop above: the view's sessions were just bulk-moved
    // into it by `createView` but the in-process backend never spawned their PTYs
    // (that only happens via `startTaskSessions`). Idempotent, so this is safe even
    // when `createView` ran against the daemon backend (already-live sessions no-op).
    void ctx.commandLoop.dispatch({ kind: 'startTaskSessions', input: { taskId: event.taskId } })
  }
})

// Close the OS window for ANY `windowClosed` domain event — not just the ones a
// window's own close-button handler already closed itself. `closeView` (window-view
// feature) emits `windowClosed` for the view AND each of its secondaries in one
// command, and those secondaries' own `BrowserWindow`s were never asked to close by
// the user, so nothing else would ever close them. `closeWindowProgrammatically`
// marks the id in `closingByCommand` first so `window.ts`'s own `'close'` handler
// (fired synchronously by `.close()`) doesn't re-dispatch a redundant close command
// for a window that's already mid-close via this path.
ctx.bus.subscribe((event) => {
  if (event.type === 'windowClosed') {
    const win = findWindow(ctx.windowIds, event.windowId)
    if (win) {
      closeWindowProgrammatically(win, event.windowId)
    }
  }
})
