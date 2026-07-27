/**
 * Window creation + lifecycle wiring (DESIGN §5.5, §6.3, §6.5, §6.7). Opens a
 * `BrowserWindow` for a given `WindowRecord` (main or secondary), connects it to
 * the composition root's `AppContext`, and wires per-window concerns:
 *
 *   - **Identity (§5.6):** the window id is injected as a `?windowId=<id>` query
 *     param on the renderer URL; the preload reads it synchronously (no IPC) so the
 *     renderer knows which window it is (main → progress panel; secondary →
 *     session-only).
 *   - **Event routing (§6.7):** the window registers its `webContents` with the
 *     `WindowRegistry`, which routes backend events to the right window(s).
 *   - **Bounds persistence (§6.3):** move/resize are debounced (~500 ms) and saved
 *     via `upsertWindow` so placement is restored on relaunch.
 *   - **Close semantics (§6.7):** closing a SECONDARY window with live sessions
 *     shows a modal (move-to-main / kill-sessions / cancel) unless the app is
 *     quitting; closing the MAIN window quits the app (graceful shutdown, §6.6).
 *
 * Security posture (§5.5): `contextIsolation` on, `nodeIntegration` off, `sandbox`
 * on — the renderer's only backend contact is the typed `window.octopusAPI` bridge.
 */

import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import type { WindowId } from '../domain/ids'
import { asWindowId, MAIN_WINDOW_ID } from '../domain/ids'
import type { WindowRecord } from '../ports/workspace-persistence'
import type { AppContext } from './composition-root'

/** How long to wait after the last move/resize before persisting bounds (§6.3). */
const BOUNDS_SAVE_DEBOUNCE_MS = 500

export interface CreateWindowOptions {
  readonly windowId: WindowId
  readonly role: 'main' | 'secondary'
  readonly bounds?: { x?: number; y?: number; width: number; height: number }
}

/**
 * Open a `BrowserWindow` for one window record and wire it into the context.
 * Returns the created window so the entry point can track it (e.g. for `activate`).
 */
export function createWindow(ctx: AppContext, opts: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: opts.bounds?.width ?? 1280,
    height: opts.bounds?.height ?? 800,
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    show: false,
    // Surface the release version (semver from package.json) in the title so users
    // can tell which build they're running — valuable after a version rollback.
    title:
      opts.role === 'main'
        ? `Octopus ${app.getVersion()}`
        : `Octopus ${app.getVersion()} — Session Window`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security posture (§5.5): renderer gets no Node access; the only bridge is
      // the typed window.octopusAPI exposed by the preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Route backend events to THIS window's renderer (§6.7). Events emitted before
  // the renderer hydrates are buffered by the registry until its getState lands.
  ctx.registry.register(opts.windowId, window.webContents)

  window.once('ready-to-show', () => window.show())

  wireBoundsPersistence(ctx, window, opts.windowId, opts.role)
  wireCloseSemantics(ctx, window, opts.windowId, opts.role)

  loadRenderer(window, opts.windowId)

  return window
}

/** Load the renderer, injecting `?windowId=<id>` so the preload can read it (§5.6). */
function loadRenderer(window: BrowserWindow, windowId: WindowId): void {
  const search = `windowId=${encodeURIComponent(windowId)}`
  // electron-vite injects ELECTRON_RENDERER_URL in dev (Vite dev server); in
  // production we load the built HTML from the renderer bundle.
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.search = search
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { search })
  }
}

/** Debounced persistence of the window's bounds on move/resize (§6.3). */
function wireBoundsPersistence(
  ctx: AppContext,
  window: BrowserWindow,
  windowId: WindowId,
  role: 'main' | 'secondary'
): void {
  let timer: ReturnType<typeof setTimeout> | undefined

  const save = (): void => {
    timer = undefined
    if (window.isDestroyed()) {
      return
    }
    const b = window.getBounds()
    ctx.deps.persistence.upsertWindow({
      id: windowId,
      role,
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      createdAt: ctx.deps.clock.now()
    })
  }

  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(save, BOUNDS_SAVE_DEBOUNCE_MS)
  }

  window.on('move', schedule)
  window.on('resize', schedule)
  // Flush a pending save synchronously on close so the last position isn't lost.
  window.on('close', () => {
    if (timer) {
      clearTimeout(timer)
      save()
    }
  })
}

/**
 * Close semantics (§6.7). Main window → quit the app. Secondary window with live
 * sessions → confirm the disposition (unless quitting), then let the `closeWindow`
 * command reassign/kill the sessions and delete the record. The `unregister` keeps
 * the registry from sending to a dead `webContents`.
 *
 * The secondary re-close uses `window.close()`, NOT `window.destroy()`: on a
 * GPU-less VDI a forced `destroy()` tears the window's display surface down out from
 * under Chromium and the whole browser process exits (clean code 0, bypassing
 * `before-quit`/`window-all-closed`). `close()` follows the same orderly teardown
 * the main window uses, so the app survives while other windows remain.
 */
function wireCloseSemantics(
  ctx: AppContext,
  window: BrowserWindow,
  windowId: WindowId,
  role: 'main' | 'secondary'
): void {
  window.on('closed', () => ctx.registry.unregister(windowId))

  if (role === 'main') {
    // Closing the main window quits the whole app (§6.7). `before-quit` runs the
    // graceful shutdown; `window-all-closed` no longer force-quits, so this is the
    // deliberate quit trigger.
    window.on('close', () => app.quit())
    return
  }

  // Once the disposition is resolved we re-close the window; this flag lets that
  // second `close` pass straight through instead of re-prompting.
  let disposed = false

  // Secondary window: intercept close to resolve its live sessions first.
  window.on('close', (e) => {
    // A quit-in-progress, or our own post-dialog re-close, must not (re)open the
    // per-window dialog (§6.7).
    if (ctx.isQuitting || disposed) {
      return
    }
    const liveSessions = sessionsInWindow(ctx, windowId)
    if (liveSessions === 0) {
      // No sessions to save; drop the window record and let the close proceed.
      void ctx.commandLoop.dispatch({
        kind: 'closeWindow',
        input: { windowId, disposition: 'move-to-main' }
      })
      return
    }

    // Cancel the OS close; ask the user what to do with the live sessions. The
    // command (once chosen) reassigns/kills them, and we re-close the window after.
    e.preventDefault()
    void promptCloseDisposition(window, liveSessions).then((choice) => {
      if (choice === 'cancel') {
        return
      }
      void ctx.commandLoop
        .dispatch({ kind: 'closeWindow', input: { windowId, disposition: choice } })
        .then(() => {
          // Re-close through the NORMAL close path (not `destroy()`): on this
          // GPU-less VDI a forced `destroy()` tears the window's display surface
          // down out from under Chromium, which exits the whole browser process
          // (clean code 0, no `before-quit`/`window-all-closed`). `close()` follows
          // the same orderly teardown the main window uses, so the app survives
          // while other windows remain. `disposed` skips the re-prompt above.
          disposed = true
          if (!window.isDestroyed()) {
            window.close()
          }
        })
    })
  })
}

/** Count the live sessions a window currently hosts (two-level scan, §6.7). */
function sessionsInWindow(ctx: AppContext, windowId: WindowId): number {
  let count = 0
  for (const task of ctx.deps.workspace.tasks()) {
    for (const session of task.sessions()) {
      if (session.windowId === windowId) {
        count++
      }
    }
  }
  return count
}

/** Modal disposition dialog for closing a secondary window with live sessions. */
async function promptCloseDisposition(
  window: BrowserWindow,
  count: number
): Promise<'move-to-main' | 'kill-sessions' | 'cancel'> {
  const plural = count === 1 ? 'session' : 'sessions'
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Move to main window', 'Close sessions', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Close window',
    message: `This window has ${count} running ${plural}.`,
    detail: 'Move them to the main window, or close them?'
  })
  if (result.response === 0) {
    return 'move-to-main'
  }
  if (result.response === 1) {
    return 'kill-sessions'
  }
  return 'cancel'
}

/**
 * Register the app-level quit sequence exactly once (§6.3, I13). `before-quit`
 * fires before windows close, giving `shutdown` a chance to SIGHUP runtimes and
 * checkpoint the store, and sets `isQuitting` so secondary windows skip their
 * close dialog. Guarded so a re-entrant quit runs teardown only once.
 */
export function registerQuitHandler(ctx: AppContext): void {
  let didShutdown = false
  app.on('before-quit', () => {
    ctx.isQuitting = true
    if (didShutdown) {
      return
    }
    didShutdown = true
    ctx.shutdown()
  })
}

/** Bounds record → CreateWindowOptions for restoring a persisted window at boot. */
export function optionsFromRecord(record: WindowRecord): CreateWindowOptions {
  return {
    windowId: record.id,
    role: record.role,
    bounds: record.bounds
  }
}

/** The main window's fixed identity (§3.7); re-exported for the entry point. */
export const MAIN_WINDOW: WindowId = MAIN_WINDOW_ID

/** Tag a raw id string as a WindowId (entry-point convenience). */
export const toWindowId = asWindowId
