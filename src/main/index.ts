/**
 * Electron main-process entry point. Builds the composition root once, then opens
 * a window against it and wires the graceful-quit hook (§6.3). All backend wiring
 * lives in `composition-root.ts`; window/lifecycle plumbing in `window.ts`.
 */

import { app, BrowserWindow } from 'electron'
import { bootstrap, type AppContext } from './composition-root'
import { createWindow, registerQuitHandler } from './window'

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
