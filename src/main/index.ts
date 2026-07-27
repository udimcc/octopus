/**
 * Electron main-process entry point (§6.3, §6.7). Builds the composition root once,
 * opens the MAIN window plus one window per persisted SECONDARY record (at
 * off-screen-clamped bounds), and wires the graceful-quit hook. All backend wiring
 * lives in `composition-root.ts`; window/lifecycle plumbing in `window.ts`.
 */

import { app, dialog, screen, BrowserWindow, Menu } from 'electron'
import { bootstrap, type AppContext } from './composition-root'
import { createWindow, registerQuitHandler, optionsFromRecord } from './window'
import { clampToDisplays, type Rect } from './window-bounds'
import { MAIN_WINDOW_ID } from '../domain/ids'
import type { WindowId } from '../domain/ids'
import type { CreateWindowOptions } from './window'

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

void app.whenReady().then(() => {
  // Remove Electron's default application menu bar (File/Edit/View/Window/Help).
  // Octopus has no use for it; the app is driven entirely through the renderer UI.
  Menu.setApplicationMenu(null)

  const records = ctx.deps.persistence.loadWindows()

  // Main window first (it owns the progress panel). Fall back to a default record
  // if somehow absent (composition-root seeds it, so this is belt-and-suspenders).
  const mainRecord = records.find((w) => w.id === MAIN_WINDOW_ID)
  restoreWindow(
    mainRecord
      ? optionsFromRecord(mainRecord)
      : { windowId: MAIN_WINDOW_ID, role: 'main', bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  )

  // Then each persisted secondary window at its restored (clamped) placement.
  for (const record of records) {
    if (record.role === 'secondary') {
      restoreWindow(optionsFromRecord(record))
    }
  }

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

// New secondary windows are created lazily in response to `windowCreated` events.
// The renderer dispatches `windows.create`; the command emits `windowCreated`;
// main opens the OS window here.
ctx.bus.subscribe((event) => {
  if (event.type === 'windowCreated' && event.role === 'secondary') {
    openWindow({ windowId: event.windowId, role: 'secondary', bounds: event.bounds })
  }
})
