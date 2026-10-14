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
 *   - **Crash recovery (§6.7):** a renderer process Chromium aborts is otherwise
 *     silent — `isDestroyed()` stays false and the user just sees a white window —
 *     so `render-process-gone` is logged and bounded-reloaded (`crash-recovery.ts`).
 *
 * Security posture (§5.5): `contextIsolation` on, `nodeIntegration` off, `sandbox`
 * on — the renderer's only backend contact is the typed `window.octopusAPI` bridge.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { WindowId } from '../domain/ids'
import { asWindowId, MAIN_WINDOW_ID } from '../domain/ids'
import type { WindowRecord } from '../ports/workspace-persistence'
import type { AppContext } from './composition-root'
import { toSafeExternalUrl } from '../shared/external-url'
import {
  busySessions,
  isBusy,
  type BusySessionsSummary
} from '../application/queries/busy-sessions'
import { CRASH_BURST_WINDOW_MS, decideCrashRecovery } from './crash-recovery'

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
  wireCrashRecovery(ctx, window, opts.windowId, opts.role)
  wireNavigationSafety(window)

  loadRenderer(window, opts.windowId)

  return window
}

/**
 * True for the app's own renderer URL — the ONLY navigation `will-navigate` lets
 * through (§13.4). Dev reload/HMR repeatedly (re)loads the Vite dev server at
 * various paths, always under the SAME origin as `ELECTRON_RENDERER_URL`, so dev
 * compares origin. In production the renderer is always the one built
 * `index.html`, loaded via `file://`; prod compares the exact file path, ignoring
 * the `?windowId=` query (which legitimately differs per window/reload).
 *
 * The dev-origin branch is gated on `ELECTRON_RENDERER_URL` being set, not on
 * `!app.isPackaged`: `loadRenderer` below picks its branch the same way, so the
 * two stay consistent by construction without a second, independent flag to
 * keep in sync.
 */
export function isOwnRendererUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return parsed.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }
  if (parsed.protocol !== 'file:') {
    return false
  }
  // `host` must also be empty: a `file://some-host/...` URL parses with a
  // non-empty host (and a different, host-relative `pathname`) that could
  // coincidentally match `indexUrl.pathname` on some platforms.
  if (parsed.host !== '') {
    return false
  }
  const indexUrl = pathToFileURL(join(__dirname, '../renderer/index.html'))
  return parsed.pathname === indexUrl.pathname
}

/**
 * Open a URL in the system browser — the one place that calls Electron's
 * `shell.openExternal` from a renderer-triggered path (§13.4): validates/
 * normalizes via `toSafeExternalUrl` and opens exactly that normalized href,
 * never the raw input a caller already checked-then-discarded, so there's no
 * gap between "checked" and "used" for the URL to be re-parsed differently.
 * Shared with the `shell:openExternal` IPC handler (`ipc-handlers.ts`) so the
 * warn-on-failure logging and the check-then-use discipline live in one place.
 */
export async function openExternalSafely(url: string): Promise<boolean> {
  const safe = toSafeExternalUrl(url)
  if (!safe) {
    return false
  }
  try {
    await shell.openExternal(safe)
    return true
  } catch (err) {
    console.warn('[octopus] shell.openExternal failed:', safe, err)
    return false
  }
}

/**
 * Navigation safety (§13.4). The renderer's CSP (`default-src 'self'`) governs
 * what the renderer can FETCH/load as a subresource — it says nothing about a
 * top-level navigation of the `BrowserWindow` itself, which CSP doesn't cover.
 * `will-navigate` is the actual control for that: it denies anything but the
 * app's own renderer URL (dev reload/HMR keeps working — see
 * `isOwnRendererUrl`), logging the blocked URL. `setWindowOpenHandler` always
 * denies opening a NEW Electron window, but opens a safe `http`/`https` target
 * in the system browser first via `openExternalSafely` (defense in depth beyond
 * the per-call `shell:openExternal` check, §13.4). xterm's `WebLinksAddon`
 * default handler is exactly the `window.open` path this denies, so the
 * terminal gets an explicit handler wired to the same `toSafeExternalUrl` +
 * `shell.openExternal` path instead (renderer-side, Subject 15).
 */
export function wireNavigationSafety(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (e, url) => {
    if (!isOwnRendererUrl(url)) {
      console.warn('[octopus] blocked navigation to:', url)
      e.preventDefault()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url)
    return { action: 'deny' }
  })
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

/**
 * Renderer-crash visibility + recovery (§6.7). Without this, a renderer that Chromium
 * aborts is completely silent: `webContents.isDestroyed()` stays FALSE, so the registry
 * keeps sending events into a dead process, Electron never respawns it, and the user sees
 * a white window with nothing in the log. (That is exactly how a Blink-heap OOM in the
 * terminal panes presented — `reason: 'crashed'`, `exitCode: 133`, no JS error. The fix
 * for the cause lives in the renderer's `cursor-blink-guard.ts`; this is the safety net.)
 *
 * On a crash we:
 *  1. log `reason`/`exitCode` with the window identity — the line whose absence made this
 *     bug take a full instrumented-repro cycle to diagnose;
 *  2. re-`register` the SAME (still valid) `webContents`, which resets the registry entry
 *     to `{ ready: false, pending: [] }`. Main stops sending into the void, stale events
 *     are dropped rather than queued, and the post-reload `getState` re-fires `markReady`
 *     and flushes normally;
 *  3. `reload()` under `decideCrashRecovery`'s bounded policy, or ask the user.
 *
 * Recovery is `webContents.reload()`, NEVER `window.destroy()` — on this GPU-less VDI a
 * forced `destroy()` tears the display surface out from under Chromium and exits the whole
 * browser process (see `wireCloseSemantics`). `reload()` replaces only the renderer process.
 *
 * KNOWN GAP: a reload re-hydrates from `getState` and re-mounts the panes, but the
 * renderer-side pre-mount buffers died with the process and the daemon already replayed
 * its ring buffer on the original attach, so terminals come back with empty scrollback and
 * fill from the next live byte. Strictly better than a white window; a scrollback-preserving
 * reload needs re-attach-on-reload (§6.2, V2).
 */
function wireCrashRecovery(
  ctx: AppContext,
  window: BrowserWindow,
  windowId: WindowId,
  role: 'main' | 'secondary'
): void {
  let attemptsInBurst = 0
  let lastCrashAt: number | null = null

  window.webContents.on('render-process-gone', (_event, details) => {
    const now = ctx.deps.clock.now()
    const msSinceLast = lastCrashAt === null ? Number.POSITIVE_INFINITY : now - lastCrashAt
    lastCrashAt = now
    if (msSinceLast > CRASH_BURST_WINDOW_MS) {
      attemptsInBurst = 0
    }
    console.error(
      `[octopus] renderer gone (${role} window ${windowId}): reason=${details.reason} exitCode=${details.exitCode}`
    )

    // A crash during quit/close is not something to heal — the window is going away.
    if (ctx.isQuitting || window.isDestroyed()) {
      return
    }

    // Point the registry at a not-ready entry so nothing is sent to (or queued for) the
    // dead renderer; the reloaded page's `getState` re-arms it.
    ctx.registry.register(windowId, window.webContents)

    if (decideCrashRecovery(details.reason, attemptsInBurst, msSinceLast) === 'reload') {
      attemptsInBurst++
      console.error(`[octopus] reloading ${role} window ${windowId} (attempt ${attemptsInBurst})`)
      window.webContents.reload()
      return
    }

    void promptCrashRecovery(window, role).then((choice) => {
      if (choice === 'reload') {
        attemptsInBurst = 0
        lastCrashAt = null
        if (!window.isDestroyed()) {
          window.webContents.reload()
        }
        return
      }
      app.quit()
    })
  })

  // Log-only diagnostics: a wedged main thread (the precursor to the OOM abort above) and
  // a renderer that never loaded both used to be invisible.
  window.webContents.on('unresponsive', () =>
    console.warn(`[octopus] renderer unresponsive (${role} window ${windowId})`)
  )
  window.webContents.on('responsive', () =>
    console.warn(`[octopus] renderer responsive again (${role} window ${windowId})`)
  )
  window.webContents.on('did-fail-load', (_e, errorCode, errorDescription, url, isMainFrame) => {
    if (isMainFrame) {
      console.error(
        `[octopus] renderer failed to load (${role} window ${windowId}): ${errorCode} ${errorDescription} ${url}`
      )
    }
  })
}

/**
 * "The window crashed" dialog, shown once the bounded auto-reloads are used up. Parented to
 * the window — safe even though its renderer is dead, since the dialog is native/main-process.
 * Closing the MAIN window quits the app anyway (§6.7), so Quit is a coherent second option.
 */
async function promptCrashRecovery(
  window: BrowserWindow,
  role: 'main' | 'secondary'
): Promise<'reload' | 'quit'> {
  const which = role === 'main' ? 'main window' : 'session window'
  const result = await dialog.showMessageBox(window, {
    type: 'error',
    buttons: ['Reload', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    title: 'Window crashed',
    message: `Octopus's ${which} stopped responding and was restarted by the system.`,
    detail:
      'Reloading restores the window from the saved workspace; terminals reconnect but start with empty scrollback. Repeated crashes are worth reporting.'
  })
  return result.response === 0 ? 'reload' : 'quit'
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
 * Modal "you have work in progress — quit anyway?" confirmation (§6.6, R4). Uses
 * the SYNCHRONOUS dialog because `before-quit` can't await: the answer must be known
 * before we decide whether to `preventDefault()`. Returns true to proceed with quit.
 * Parented to the focused window so it centers on-screen (falls back to modeless).
 */
function confirmQuitWhileBusy(summary: BusySessionsSummary): boolean {
  const parts: string[] = []
  if (summary.working > 0) {
    parts.push(`${summary.working} working`)
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked} needing input`)
  }
  const taskPlural = summary.tasks === 1 ? 'task' : 'tasks'
  const parent = BrowserWindow.getFocusedWindow() ?? undefined
  const response = dialog.showMessageBoxSync(parent as BrowserWindow, {
    type: 'warning',
    buttons: ['Quit anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Quit Octopus?',
    message: `You have running sessions (${parts.join(', ')}) across ${summary.tasks} ${taskPlural}.`,
    detail: 'Quitting closes their shells and loses any unsaved work in progress.'
  })
  return response === 0
}

/**
 * Register the app-level quit sequence exactly once (§6.3, I13). `before-quit`
 * fires before windows close, giving `shutdown` a chance to release runtimes and
 * checkpoint the store, and sets `isQuitting` so secondary windows skip their
 * close dialog. Guarded so a re-entrant quit runs teardown only once.
 *
 * Work-in-progress warning (§6.6, R4, I13): on the IN-PROCESS backend quitting
 * SIGHUPs every live shell, so an agent mid-task or a shell blocked on input loses
 * its work. Before committing to quit we count the live `Working`/`Blocked` sessions
 * and, if any, ask for confirmation — cancelling `preventDefault()`s the quit and
 * leaves `isQuitting` unset. The DAEMON backend keeps its PTYs running for re-attach
 * (§6.2), so there is nothing to lose and the warning is skipped.
 *
 * Daemon backend (§6.2): before the synchronous `shutdown` detaches and drops the
 * socket we must first query the live roster to persist each session's `last_cwd` —
 * an async round-trip. `before-quit` can't await, so we `preventDefault()` the
 * first quit, run the flush, then re-issue `app.quit()`; the second pass (flush
 * already done) proceeds straight to teardown. The in-process path has nothing
 * async to do and tears down inline on the first pass (unchanged).
 */
export function registerQuitHandler(ctx: AppContext): void {
  let didShutdown = false
  let didFlushCwds = false
  app.on('before-quit', (event) => {
    if (didShutdown) {
      ctx.isQuitting = true
      return
    }
    // In-process backend only: quitting kills live shells, so warn if any session
    // is Working/Blocked and let the user back out. Daemon PTYs survive quit (§6.2),
    // so skip. Runs before `isQuitting` is set so a cancel leaves windows intact.
    if (!ctx.daemonActive()) {
      const summary = busySessions(ctx.deps.workspace)
      if (isBusy(summary) && !confirmQuitWhileBusy(summary)) {
        event.preventDefault()
        return
      }
    }
    ctx.isQuitting = true
    // Daemon path: defer once to persist cwds while the socket is still up.
    if (ctx.daemonActive() && !didFlushCwds) {
      event.preventDefault()
      didFlushCwds = true
      void ctx
        .persistDaemonCwds()
        .catch(() => {
          // Best-effort — a failed flush just falls back to worktree cwd on respawn.
        })
        .finally(() => app.quit())
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
