/**
 * Electron main-process entry point. Builds the composition root once, then opens
 * a window against it and wires the graceful-quit hook (§6.3). All backend wiring
 * lives in `composition-root.ts`; window/lifecycle plumbing in `window.ts`.
 */

import { app, BrowserWindow } from 'electron'
import { bootstrap, type AppContext } from './composition-root'
import { createWindow, registerQuitHandler } from './window'

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
const ctx: AppContext = bootstrap()
registerQuitHandler(ctx)

void app.whenReady().then(() => {
  createWindow(ctx)

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(ctx)
    }
  })
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
