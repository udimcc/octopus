/**
 * Window creation + lifecycle wiring (DESIGN §5.5, §6.3, §6.5). Extracts the
 * `BrowserWindow` setup from the entry point and connects it to the composition
 * root's `AppContext`: attaches the window's `webContents` to the event-forwarder
 * so backend events reach the renderer, and registers the quit hook that runs the
 * graceful shutdown (SIGHUP runtimes + checkpoint the store, I13).
 *
 * Security posture (§5.5): `contextIsolation` on, `nodeIntegration` off, `sandbox`
 * on — the renderer's only backend contact is the typed `window.octopusAPI` bridge
 * exposed by the preload.
 */

import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { AppContext } from './composition-root'

export function createWindow(ctx: AppContext): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'Octopus',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security posture (§5.5): renderer gets no Node access; the only bridge is
      // the typed window.octopusAPI exposed by the preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Forward backend events to THIS window's renderer (§6.5). Events emitted before
  // the renderer hydrates are buffered by the forwarder until its getState lands.
  ctx.forwarder.attach(window.webContents)

  window.once('ready-to-show', () => window.show())

  // electron-vite injects ELECTRON_RENDERER_URL in dev (Vite dev server); in
  // production we load the built HTML from the renderer bundle.
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * Register the app-level quit sequence exactly once (§6.3, I13). `before-quit`
 * fires before windows close, giving `shutdown` a chance to SIGHUP runtimes and
 * checkpoint the store. Guarded so a re-entrant quit runs teardown only once.
 */
export function registerQuitHandler(ctx: AppContext): void {
  let didShutdown = false
  app.on('before-quit', () => {
    if (didShutdown) {
      return
    }
    didShutdown = true
    ctx.shutdown()
  })
}
