/**
 * The composition root (DESIGN §2): the ONLY place that knows concrete adapters
 * and wires them to the ports the application depends on. Localizing the
 * Electron/node-pty/SQLite choices here is what lets the domain stay pure and the
 * edges stay swappable — no other layer imports an adapter (boundary rule).
 *
 * Bootstrap order (V0 order preserved, extended):
 *   0. darwin only: `applyLoginShellEnv()` merges the login shell's PATH/locale into
 *      `process.env` (a Finder/Dock launch has a bare launchd PATH) before anything
 *      inherits it — octopusd, PTYs, worktree scripts, the Claude hook install.
 *   1. `raiseFileLimit()` FIRST — child PTYs inherit the higher soft fd limit (§6.1).
 *   2. `ensureAppDirs()` — data + logs dirs exist before any store opens.
 *   3. Build adapters behind their ports (clock, ids, bus, settings, persistence,
 *      script runner, worktree provider, PTY manager, session-type registry +
 *      Terminal provider, ajv config validator).
 *   4. `persistence.load()` → `Workspace.hydrate` → `reconcileStaleGroups` (sweep
 *      `session_groups` rows hydrate rejected, review I1) → `reconcileOnStartup`
 *      (missing worktree → Stale, I14) → `pruneStaleViews` (drop a view's window
 *      record, plus its secondaries', for a task gone from the hydrated workspace —
 *      "Window View" — strictly before `index.ts` restores any window).
 *   5. `new CommandLoop(deps)`; late-bind `deps.onRuntimeExit` to route a runtime's
 *      spontaneous exit back through the loop as `handleRuntimeExit` (single-writer,
 *      §6.6). Also dispatch the one-shot `seedProjects` command here, fire-and-forget
 *      (§6.3): it is enqueued right after the loop is built and the late-bound sinks
 *      above are wired, so it runs after hydrate/reconcile (step 4) and before IPC
 *      registration (step 6) — a UI-triggered `addProject`/`removeProject` can only
 *      reach the loop once IPC handlers exist, so it always waits behind this seed.
 *   6. Create the window registry (event router) + register IPC handlers.
 *
 * Returns an `AppContext` the entry point (`index.ts`/`window.ts`) uses to open a
 * window, forward events, and shut down cleanly (§6.3 quit).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveProgramDir, resolveUpdateStagingDir } from '../adapters/env/paths'
import { raiseFileLimit } from '../adapters/env/raise-file-limit'
import { applyLoginShellEnv } from '../adapters/env/login-shell-env'
import {
  ensureAppDirs,
  ensureWorktreeBase,
  resolveWorktreeBase,
  type AppPaths
} from '../adapters/env/paths'
import { systemClock } from '../adapters/clock/system-clock'
import { UuidIdGenerator } from '../adapters/id/uuid-id-generator'
import { InMemoryEventBus } from '../adapters/event-bus/in-memory-event-bus'
import { JsonSettingsStore } from '../adapters/settings/json-settings-store'
import { openSqliteStore } from '../adapters/persistence/open-database'
import { ChildProcessScriptRunner } from '../adapters/scripts/child-process-script-runner'
import { ScriptWorktreeProvider } from '../adapters/worktree/script-worktree-provider'
import { NativeGitWorktreeProvider } from '../adapters/worktree/native-git-worktree-provider'
import { SelectingWorktreeProvider } from '../adapters/worktree/selecting-worktree-provider'
import {
  ensureShellIntegrationFiles,
  type ShellIntegrationFiles
} from '../shared/node/shell-integration'
import { createStateLogFile } from '../adapters/observability/state-log-file'
import { ensureClaudeHooks } from '../adapters/claude/claude-hooks'
import {
  createClaudeStateWatcher,
  pruneClaudeStateDir,
  type ClaudeStateWatcher
} from '../adapters/claude/claude-state-watcher'
import { PtySessionManager } from '../adapters/session/pty-session-manager'
import { DaemonClient } from '../adapters/session/daemon-client'
import { DaemonSessionManager } from '../adapters/session/daemon-session-manager'
import { SwitchableSessionManager } from '../adapters/session/switchable-session-manager'
import { controlSocketPath, currentUid } from '../shared/node/daemon-paths'
import { RingBufferScrollbackStore } from '../adapters/session/scrollback-store'
import { InMemorySessionTypeRegistry } from '../adapters/session-types/session-type-registry'
import { TerminalSessionTypeProvider } from '../adapters/session-types/terminal-session-type-provider'
import { existsDir } from '../adapters/fs/dir-exists'
import { existsFile } from '../adapters/fs/file-exists'
import { ElectronClipboard } from '../adapters/clipboard/electron-clipboard'
import {
  LiteLLMJiraSource,
  DEFAULT_LITELLM_BASE_URL,
  DEFAULT_JIRA_SERVER_ID
} from '../adapters/jira/litellm-jira-source'
import { createHttpsFetch } from '../adapters/jira/https-fetch'
import { SafeStorageCredentials } from '../adapters/credentials/safe-storage-credentials'
import { JIRA_API_KEY_REF } from '../ports/credentials-provider'
import { app, BrowserWindow, safeStorage } from 'electron'
import { FsUpdateSource } from '../adapters/update/fs-update-source'
import { NullUpdateSource } from '../adapters/update/null-update-source'
import { createUpdateChecker } from '../application/use-cases/check-for-updates'
import { createUpdateInstaller } from '../application/use-cases/install-update'
import { createUpdateScheduler, type UpdateScheduler } from './update-scheduler'
import { skipBusyQuitWarning } from './window'
import { createAjvConfigValidator } from '../application/config-validator'
import {
  MapRuntimeRegistry,
  type AppDependencies,
  type SessionStateNotification
} from '../application/dependencies'
import { CommandLoop } from '../application/command-loop'
import { createControlServer, type ControlServer } from '../adapters/control/control-server'
import { createControlHandlers } from './control-handlers'
import { reconcileOnStartup, reconcileStaleGroups } from '../application/reconcile'
import { pruneStaleViews } from '../application/use-cases/prune-stale-views'
import { shutdown } from '../application/quit'
import { flushScrollbacks } from '../application/flush-scrollbacks'
import {
  createScrollbackFlushScheduler,
  SCROLLBACK_FLUSH_TICK_BYTES,
  type ScrollbackFlushScheduler
} from './scrollback-flush-scheduler'
import { worstStatusWins } from '../domain/task-state-aggregator'
import { Workspace } from '../domain/workspace'
import { TaskLifecycle } from '../domain/lifecycle'
import type { Settings } from '../ports/settings-store'
import type { EventBus } from '../ports/event-bus'
import type { EventDTO } from '../shared/events'
import { MAIN_WINDOW_ID, asSessionId, type SessionId, type WindowId } from '../domain/ids'
import { locateSession } from '../application/use-cases/locate-session'
import { listProjects } from '../application/queries/list-projects'
import { CURRENT_VERSION } from '../shared/version'
import { registerIpcHandlers } from './ipc-handlers'
import { createWindowRegistry, type WindowRegistry } from './window-registry'

/** Where releases are published when `settings.updates.dir` is unset. */
const DEFAULT_UPDATES_DIR = '/mnt/scratch/octopus'
/** Listing the (network) updates dir gives up after this long -> `unreachable`. */
const UPDATE_CHECK_TIMEOUT_MS = 10_000
/** Copying the (~300 MB) release to the local staging dir gives up after this long. */
const UPDATE_STAGE_TIMEOUT_MS = 3 * 60_000
/** A release's install.sh (copy + swap) must finish within this. */
const UPDATE_INSTALL_TIMEOUT_MS = 5 * 60_000

export interface AppContext {
  /** Hourly update check + status push; started by index.ts once windows are up. */
  readonly updateScheduler: UpdateScheduler
  /** Periodic dirty-scrollback flush (§6.6); started by index.ts, stopped by `shutdown`. */
  readonly scrollbackFlusher: ScrollbackFlushScheduler
  /**
   * Synchronously persist every dirty session's scrollback now (§6.6), with no byte
   * budget. Called first thing on quit and on a system shutdown, before anything
   * async can be cut short. A no-op once `shutdown` closed the store.
   */
  readonly flushScrollbacks: () => void
  readonly paths: AppPaths
  readonly commandLoop: CommandLoop
  /**
   * `octopus-cli` control socket (control socket design). Built here, but `index.ts`
   * calls `listen()` after the single-instance lock; `shutdown()` closes it first.
   */
  readonly controlServer: ControlServer
  readonly deps: AppDependencies
  readonly bus: EventBus
  /** Routes backend events to the right window(s) (§6.7); replaces the forwarder. */
  readonly registry: WindowRegistry
  /**
   * webContents.id → WindowId, populated as windows open (V1.5, §6.7). Backs the
   * `windowAtPoint` hit-test and per-window `markReady` (via `e.sender`).
   */
  readonly windowIds: Map<number, WindowId>
  /**
   * True once `before-quit` has fired (§6.7). Read by secondary windows to skip
   * their close dialog during a graceful quit. Mutable by design.
   */
  isQuitting: boolean
  /**
   * Async daemon warmup (§6.2). Called at the very start of `app.whenReady()`,
   * BEFORE any window opens and thus before the first `switchTask` triggers
   * `startTaskSessions`. When `terminal.backend === 'daemon'` it connects-or-launches
   * `octopusd`, fills `liveDaemonSessions` from its roster, closes orphaned daemon
   * PTYs (ids absent from the hydrated workspace), and swaps `deps.sessions` to the
   * daemon backend. On the in-process path (or if the daemon can be neither reached
   * nor launched) it is a no-op and the in-process backend stays — today's behavior.
   */
  readonly warmupSessions: () => Promise<void>
  /**
   * Daemon path only: dispatch `startTaskSessions` for every Ready task (re-attach or
   * fresh-spawn at boot). Call AFTER the boot windows are registered, or the first
   * session's restored history is published to no window and lost from its pane.
   */
  readonly startReadyTasks: () => void
  /** True once the durable daemon backend is confirmed reachable AND adopted (§6.2). */
  readonly daemonActive: () => boolean
  /**
   * Daemon path only (§6.2, §6.3): query the live roster and persist each session's
   * current `last_cwd` while the socket is still up, so a later fresh spawn (daemon
   * gone / session died) reopens at where the user left off. Awaited by the quit
   * handler BEFORE the synchronous `shutdown` drops the socket. No-op in-process.
   */
  readonly persistDaemonCwds: () => Promise<void>
  /**
   * Graceful teardown (§6.3): release runtimes — SIGHUP (in-process) or DETACH
   * (daemon, PTYs survive for re-attach) — flush scrollback, and checkpoint/close
   * the store (I13). Synchronous; the daemon-cwd flush runs before it via the quit
   * handler.
   */
  readonly shutdown: () => void
}

/**
 * Resolve which window an in-app notification (§9.5) should target: the currently
 * focused window if we can map its `webContents.id` to a known `WindowId`,
 * otherwise the main window. Pure so it's unit-testable without Electron —
 * `focusedWebContentsId` is `undefined` when the app is blurred (the common case
 * for a background status change) or when the focused surface isn't a tracked
 * Octopus window (e.g. devtools).
 */
export function resolveNotificationTargetWindow(
  focusedWebContentsId: number | undefined,
  windowIds: ReadonlyMap<number, WindowId>,
  mainId: WindowId
): WindowId {
  if (focusedWebContentsId !== undefined) {
    const mapped = windowIds.get(focusedWebContentsId)
    if (mapped !== undefined) {
      return mapped
    }
  }
  return mainId
}

/**
 * Find the live `BrowserWindow` for a tracked `WindowId`, skipping any window
 * Electron has already torn down. Shared by the three places that resolve a
 * window by id and then act on it — `activeSessionChanged`'s cross-window
 * raise, the §9.5 toast's forced repaint, and the issues-drawer-toggle relay —
 * so the destroyed-check and the `windowIds` reverse-lookup live in one place
 * (§13.4, §6.7).
 */
export function findWindow(
  windowIds: ReadonlyMap<number, WindowId>,
  id: WindowId
): BrowserWindow | undefined {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (windowIds.get(win.webContents.id) === id) {
      return win
    }
  }
  return undefined
}

/**
 * Bring a window to the foreground (un-minimize, show, focus) and force a
 * repaint. The repaint is the GPU-less VDI passive-repaint workaround used
 * throughout this file: `invalidate()` just schedules a full repaint (no-op
 * cost on a real GPU), needed because SwiftShader doesn't otherwise paint a
 * freshly-raised-but-uninteracted window's first frame.
 */
export function raiseWindow(win: BrowserWindow): void {
  if (win.isMinimized()) {
    win.restore()
  }
  win.show()
  win.focus()
  win.webContents.invalidate()
}

export function bootstrap(): AppContext {
  // 0. darwin: adopt the login shell's PATH/locale (GUI launches get launchd's bare
  // PATH). Must precede everything that spawns or snapshots `process.env` — notably
  // the daemon (launched later by `warmupSessions`, inheriting this env) and the
  // Claude hook install below. Best-effort; a no-op off darwin.
  if (process.platform === 'darwin') {
    const loginEnv = applyLoginShellEnv({ platform: process.platform, env: process.env })
    console.log(`[octopus] login shell env: ${loginEnv.message}`)
  }

  // 1. Raise the fd limit FIRST so child PTYs inherit the higher soft limit (§6.1).
  const rlimit = raiseFileLimit()
  console.log(`[octopus] RLIMIT_NOFILE: ${rlimit.message}`)

  // 2. Ensure data + logs dirs exist before any store opens.
  const paths = ensureAppDirs()
  console.log(`[octopus] data dir ensured at ${paths.dataDir}`)

  // 3. Build adapters behind their ports.
  const clock = systemClock
  const ids = new UuidIdGenerator()
  const bus = new InMemoryEventBus()
  const settings = new JsonSettingsStore(paths.settingsPath)
  // Load settings once up-front (the worktree provider reads them live via this).
  settings.load()
  const getSettings = (): Settings => settings.load()

  const persistence = openSqliteStore(paths.dbPath)

  const scriptRunner = new ChildProcessScriptRunner()
  // Worktree provisioning is auto-detected per task (§6.4): a repo that ships
  // `create_worktree.sh` owns provisioning (ScriptWorktreeProvider); otherwise
  // Octopus runs `git worktree` itself under the configured base dir
  // (NativeGitWorktreeProvider). `SelectingWorktreeProvider` probes the task's
  // repoDir per call and routes accordingly. Both run through the same argv-only
  // ScriptRunner (I17). The native base dir is resolved live from settings and
  // ensured on disk (git won't create the parent).
  const onWorktreeWarning = (message: string): void =>
    console.warn(`[octopus] worktree: ${message}`)
  const worktrees = new SelectingWorktreeProvider({
    script: new ScriptWorktreeProvider({
      runner: scriptRunner,
      getSettings,
      onWarning: onWorktreeWarning
    }),
    native: new NativeGitWorktreeProvider({
      runner: scriptRunner,
      getSettings,
      resolveBase: () =>
        ensureWorktreeBase(resolveWorktreeBase(getSettings().worktree.location, homedir())),
      onWarning: onWorktreeWarning
    }),
    hasScript: existsFile
  })

  // OSC 133 shell-integration files (§12.1): generate the bash/zsh rc files once at
  // boot so every terminal launches against them (opt-out auto-injection). Best-effort
  // — an I/O failure just means no injection (a plain login shell); the at-prompt
  // sentinel then relies on tcgetpgrp alone rather than breaking session startup.
  let shellIntegration: ShellIntegrationFiles | undefined
  try {
    shellIntegration = ensureShellIntegrationFiles(paths.shellIntegrationDir)
    console.log(`[octopus] shell integration written to ${paths.shellIntegrationDir}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[octopus] shell integration unavailable, using plain login shells: ${message}`)
  }

  // State-transition log (§11, R1): append one JSONL line per state change to
  // `logs/state.log` (dir ensured by `ensureAppDirs`). Best-effort — the adapter
  // swallows its own I/O errors and warns once, so a persistently-unwritable log
  // never derails the command loop or spams stderr.
  const stateLog = createStateLogFile({
    path: paths.stateLogPath,
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[octopus] state log unavailable, transitions will not be recorded: ${message}`)
    }
  })

  // Claude Code hooks (§9.2, §12.1): merge-safe ensure so Claude sessions get
  // authoritative Layer-3 state out of the box for ANY Octopus user. Opt-out via
  // `terminal.injectClaudeHooks === false`. Best-effort: never blocks boot.
  if (getSettings().terminal.injectClaudeHooks !== false) {
    const hooks = ensureClaudeHooks(paths.dataDir, homedir())
    console.log(`[octopus] claude hooks: ${hooks.action} (${hooks.path})`)
  }

  // Session backend (§6.2). We ALWAYS start on the in-process PTY manager and,
  // unless `terminal.backend === 'in-process'`, swap to the durable daemon backend
  // during the async `warmupSessions()` below — but only once a reachable `octopusd`
  // is confirmed. The daemon is the DEFAULT: only an explicit `'in-process'` opts out.
  // This honors the chosen fallback: if the daemon can be neither reached nor launched,
  // the switchable manager simply stays in-process for the run. Wiring the daemon
  // client here (not connecting) keeps `bootstrap()` synchronous.
  const inProcessSessions = new PtySessionManager({
    getSettings,
    shellIntegration,
    controlSocketPath: paths.controlSocketPath
  })
  const sessions = new SwitchableSessionManager(inProcessSessions)
  const daemonClient = new DaemonClient({
    socketPath: controlSocketPath(currentUid()),
    daemonEntry: join(__dirname, 'daemon.js'),
    daemonVersion: CURRENT_VERSION.toString()
  })
  const daemonSessions = new DaemonSessionManager({
    client: daemonClient,
    getSettings,
    shellIntegration,
    // Rides in the spawn `envPatch` (no daemon protocol change).
    controlSocketPath: paths.controlSocketPath
  })
  // Filled by `warmupSessions()` from the daemon's live roster; empty on the
  // in-process path (→ every restored session spawns fresh, V1 behavior).
  const liveDaemonSessions = new Set<SessionId>()
  // Flipped true by `warmupSessions()` only once the daemon is confirmed reachable
  // AND adopted (`setDelegate`). The quit path reads it to choose detach-not-kill;
  // it stays false when the setting is in-process OR the daemon degraded (§6.2).
  let daemonActive = false

  const registry = new InMemorySessionTypeRegistry()
  registry.register(new TerminalSessionTypeProvider())

  const configValidator = createAjvConfigValidator()
  const aggregator = worstStatusWins
  const runtimes = new MapRuntimeRegistry()
  // Per-session output accumulator (§6.6): captured on every `onData`, flushed to
  // `session_scrollback` periodically and on quit/exit, replayed on restart.
  // Structurally implements the application's `ScrollbackBuffers` port (the
  // interface-in-app / impl-in-adapter split mirrors MapRuntimeRegistry).
  const scrollbacks = new RingBufferScrollbackStore()

  // 4. Load persisted state, hydrate the workspace, reconcile worktrees (I14).
  const snapshot = persistence.load()
  const workspace = Workspace.hydrate(snapshot, {
    defaultSessionTypeId: getSettings().defaultSessionTypeId
  })

  // 4b. Seed the main window record if absent (V1.5, §6.7). The v4 migration's
  //     INSERT OR IGNORE covers an upgraded DB; this belt-and-suspenders covers a
  //     fresh DB (created by CREATE TABLE, which seeds no rows) so `loadWindows`
  //     always includes `main` and hydration never orphans a session (I18).
  if (!persistence.loadWindows().some((w) => w.id === MAIN_WINDOW_ID)) {
    persistence.upsertWindow({
      id: MAIN_WINDOW_ID,
      role: 'main',
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      createdAt: clock.now()
    })
  }

  const deps: AppDependencies = {
    workspace,
    persistence,
    settings,
    worktrees,
    sessions,
    registry,
    runtimes,
    bus,
    ids,
    clock,
    aggregator,
    configValidator,
    stateLog,
    scrollbacks,
    // Default session cwd for "No Repo" tasks (§5.4): resolved once here so the
    // use case never touches the OS. `homedir()` is the same base the worktree
    // resolver uses above.
    homeDir: homedir(),
    currentVersion: CURRENT_VERSION,
    // Live at construction: the SAME Set instance the warmup fills before any
    // session starts (use-cases read it lazily via `has`, §6.2).
    liveDaemonSessions
  }

  // 4c. Sweep any `session_groups` rows `Task.fromSnapshot`/`restoreGroups`
  //     rejected at hydrate above (review I1) — an unknown/duplicate leaf, <2
  //     surviving members, members split across windows, non-contiguous tabs, or
  //     a tree that failed to validate. `snapshot` is persistence's own
  //     pre-hydrate read, the only place the full as-persisted group id list is
  //     still available (`Task` never keeps the rejects). Must run before the
  //     command loop accepts any command (§6.6), same ordering as
  //     `reconcileOnStartup` below.
  reconcileStaleGroups(deps, snapshot)

  reconcileOnStartup(deps, { existsDir })

  // 4d. Discard view window records (plus their secondaries) whose task no longer
  //     exists in the hydrated workspace ("Window View" — a view restored for a
  //     deleted task is silently dropped, never shown). Must run before any window
  //     is restored (`index.ts`, which runs strictly after `bootstrap()` returns) and
  //     before the command loop accepts a command that could race it.
  pruneStaleViews(deps)

  // 5. Command loop; late-bind the spontaneous-exit sink to re-enter the loop
  //    (so `markExited` runs on the single writer, never inline in a PTY callback).
  const commandLoop = new CommandLoop(deps)
  deps.onRuntimeExit = (sessionId, exitCode, signal): void => {
    void commandLoop.dispatch({
      kind: 'handleRuntimeExit',
      input: { sessionId, exitCode, signal }
    })
  }
  // Route each session-state change through the loop as `ingestSessionState` (§9.6),
  // so `setState` + the task re-derivation run on the single writer, never inline in
  // the watcher's file-change callback (§6.6). Same late-bind pattern as above.
  deps.onSessionState = (sessionId, state, meta): void => {
    void commandLoop.dispatch({
      kind: 'ingestSessionState',
      input: { sessionId, state, meta }
    })
  }

  // One-shot project seed (§6.3): best-effort, non-blocking, fire-and-forget.
  // Dispatched here — after hydrate/reconcile and the late-bound sinks above
  // (steps 4-5), before IPC registration (step 6) and before `warmupSessions()`
  // runs — so a UI-triggered `addProject`/`removeProject` necessarily queues
  // behind it (its IPC handler doesn't exist yet to even enqueue one earlier).
  // It reads `deps.workspace.tasks()` as populated by `Workspace.hydrate` +
  // `reconcileOnStartup`; reconciliation only flips a missing-worktree task's
  // lifecycle to `Stale`, it doesn't remove it from `tasks()`, so this does NOT
  // see a filtered-down "reconciled task set" — just the hydrated one.
  // `CommandLoop.dispatch` never rejects (every error inside a use case, or
  // thrown directly, becomes a `{ ok: false, error }` result — see
  // `command-loop.ts`'s `execute()`), so only that branch is reachable; no
  // `.catch` is needed here.
  void commandLoop.dispatch({ kind: 'seedProjects', input: {} }).then((result) => {
    if (!result.ok) {
      console.warn(`[octopus] project seed failed: ${result.error}`)
    }
  })

  // Claude state watcher (§9.3, §9.6): the SOLE source of session-state. The python
  // recorder (wired into settings.json above) appends every Claude hook to
  // `<sessionId>.events.jsonl` under `claudeStateDir`; the watcher folds each TRACKED
  // session's log and feeds each state change through `onSessionState`. A session is
  // tracked from its runtime start (`prepareClaudeState`): a fresh PTY drops the old
  // log (its Claude is gone), a daemon re-attach replays it (its Claude may still be
  // running). Logs of sessions the workspace no longer holds are pruned here. Gated by
  // the same opt-out as hook injection; the log's stem is OCTOPUS_SESSION_ID.
  let claudeStateWatcher: ClaudeStateWatcher | undefined
  if (getSettings().terminal.injectClaudeHooks !== false) {
    const keep = new Set<string>()
    for (const task of workspace.tasks()) {
      for (const session of task.sessions()) keep.add(session.id)
    }
    pruneClaudeStateDir(paths.claudeStateDir, keep)
    claudeStateWatcher = createClaudeStateWatcher({
      dir: paths.claudeStateDir,
      sink: (sessionId, state, meta) => deps.onSessionState?.(asSessionId(sessionId), state, meta),
      onError: (message) => console.warn(`[octopus] claude state watcher: ${message}`)
    })
    // The "refresh state" affordance (§5.4 R1): re-fold one session's log NOW and
    // re-emit. Late-bound like the sinks above so the use-cases stay pure application
    // code with no adapter import.
    deps.refreshClaudeState = (sessionId): void => claudeStateWatcher?.rescan(sessionId)
    deps.prepareClaudeState = (sessionId, mode): void => {
      if (mode === 'fresh') claudeStateWatcher?.reset(sessionId)
      else claudeStateWatcher?.attach(sessionId)
    }
  }

  // 6. Window registry + IPC handlers (§6.7). The registry routes each event to the
  //    window(s) that should see it; `resolveSessionWindow` looks up a session's
  //    current window via the live workspace (undefined once it's removed → the
  //    registry broadcasts, so a just-closed tab's event still reaches its window).
  const windowRegistry = createWindowRegistry(
    bus,
    (sessionId) => {
      const located = locateSession(workspace, asSessionId(sessionId))
      return located?.session.windowId
    },
    // View-awareness ("Window View"): a view (and its own secondaries) is
    // permanently pinned to its task, so `activeTaskChanged` must skip the whole
    // group (window-registry.ts header, `viewTaskIdForWindow`). Read straight from
    // persistence rather than tracking a parallel in-memory map — this is only
    // consulted on a task switch (not a hot path, and read once per broadcast, not
    // once per window — see `LoadWindowRecords`) and persistence is always the
    // live ground truth for a window's role/taskId, including a boot-restored view
    // that never went through `windowCreated`.
    () => deps.persistence.loadWindows()
  )

  // webContents.id → WindowId, filled as windows open (backs windowAtPoint +
  // per-window markReady). Mutated by the entry point/window.ts as windows appear.
  const windowIds = new Map<number, WindowId>()

  // Cross-window session switch (§5.4): when the active session moves to a session
  // hosted in another window, bring THAT OS window to the foreground so the switch
  // is visible. The host window's renderer already moves its mark on the same
  // broadcast; this is the OS-level raise the renderer can't do. Resolve the target window by
  // reversing `windowIds` (webContents.id → WindowId). Kept here (composition root)
  // because only main owns `BrowserWindow`; the registry stays transport-agnostic.
  bus.subscribe((event) => {
    if (event.type !== 'activeSessionChanged') return
    const win = findWindow(windowIds, event.windowId)
    if (win) {
      raiseWindow(win)
    }
  })

  // In-app status-change notification (§9.5): bound AFTER `windowRegistry` (line
  // above) and `windowIds` exist — it closes over both. `ingestSessionState` calls
  // this on a meaningful transition; here we gate on the user setting (read live),
  // resolve the ACTIVE window (main-window fallback), and send the toast to just
  // that window (never broadcast — it's not on the bus). Kept in the composition
  // root because only main owns `BrowserWindow`; the use-case stays window-agnostic.
  // Emit ONE toast: route it to the active window and force the VDI repaint. Kept
  // separate from `push` so the throttle (below) owns the burst suppression and this
  // owns the window plumbing.
  const emitStateNotification = (n: SessionStateNotification): void => {
    // NOTE: whether to SUPPRESS the toast because the user is already looking at the
    // session that changed (§9.5) is decided in the RENDERER, not here. Only the
    // renderer authoritatively knows what's on screen in its window — `isSessionFocused`
    // (store.ts) folds live DOM focus (`windowFocused`) with the active task/tab and
    // this-window host. Deciding it here from `BrowserWindow.getFocusedWindow()` +
    // domain `activeSessionId` sampled at ingestion is racy and direction-asymmetric
    // (the `working → waiting` path's repaint + post-Stop hook shift focus after the
    // sample), which let "finished" toasts leak through while "started" ones were
    // suppressed. Main just routes to the focused window (main fallback); the renderer
    // drops it if that window is in fact viewing the session.
    const focused = BrowserWindow.getFocusedWindow()
    const target = resolveNotificationTargetWindow(
      focused && !focused.isDestroyed() ? focused.webContents.id : undefined,
      windowIds,
      MAIN_WINDOW_ID
    )
    const dto: EventDTO = {
      type: 'sessionStateNotification',
      sessionId: n.sessionId,
      taskName: n.taskName,
      sessionName: n.sessionName
    }
    windowRegistry.sendTo(target, dto)
    // A status change is a PASSIVE update — it arrives while the user is looking at
    // (or typing in) some other window, not interacting with the target. On the
    // GPU-less VMware VDI, Chromium's SwiftShader compositor doesn't push a fresh
    // frame for a passive DOM mutation until some input/resize wakes it, so the
    // freshly-pushed toast paints late (or not until the next interaction) — exactly
    // the "I can't see any notification" symptom. Force a full repaint of the target
    // window so the toast shows immediately. Only a repaint, never a raise (§9.5):
    // a passive toast must not steal focus. `findWindow` returns `undefined` for a
    // destroyed/absent webContents, which the optional call below just skips.
    findWindow(windowIds, target)?.webContents.invalidate()
  }

  // Gate on the user setting and route to the active window (§9.5). The BURST throttle
  // (Claude's `working → waiting → blocked` turn-end double-write → ONE toast) lives in
  // the RENDERER (store.ts + store/notification-throttle.ts), NOT here: its cooldown must
  // be anchored to the toast the user actually SAW, and whether a toast is shown depends
  // on per-window focus suppression (`isSessionFocused`) that only the renderer knows.
  // Throttling here armed the window on every emit attempt, so a focus-suppressed
  // `waiting → working` swallowed the later `working → waiting` "it finished" toast — the
  // "I don't always see the toast" bug. Main just forwards; the renderer throttles.
  deps.onSessionStateNotification = (n): void => {
    if (getSettings().terminal.statusChangeNotifications === false) {
      return
    }
    emitStateNotification(n)
  }

  // Jira import (DESIGN "Jira import", I16). `SafeStorageCredentials`'s ctor never
  // touches `safeStorage` itself (only `resolve`/`set`/`has` do, lazily) — `bootstrap`
  // runs before `app.whenReady()`, so constructing it here is safe even though
  // `safeStorage` isn't usable yet. `getApiKey` checks `has` first so a missing key
  // resolves to `undefined` (→ the port's `noKey` error) instead of `resolve`
  // throwing.
  const credentials = new SafeStorageCredentials(safeStorage, paths.credentialsDir)
  const jiraSource = new LiteLLMJiraSource({
    // Not `globalThis.fetch`: that ignores the system CA store, which holds the
    // gateway's internal CA (https-fetch.ts).
    fetch: createHttpsFetch(),
    getApiKey: async () => {
      const hasKey = await credentials.has(JIRA_API_KEY_REF)
      return hasKey ? credentials.resolve(JIRA_API_KEY_REF) : undefined
    },
    baseUrl: DEFAULT_LITELLM_BASE_URL,
    serverId: DEFAULT_JIRA_SERVER_ID
  })

  // Self-update is Linux-only: releases are Linux tarballs whose `install.sh` must
  // never run on a Mac, so darwin gets a source that never finds a candidate (the
  // checker reports "up to date"; the installer has nothing to install), regardless
  // of whether `/mnt/scratch` or a hidden `updates.dir` is reachable.
  const updateSource =
    process.platform === 'darwin'
      ? new NullUpdateSource()
      : new FsUpdateSource({
          stagingRoot: resolveUpdateStagingDir(process.env, homedir()),
          stageTimeoutMs: UPDATE_STAGE_TIMEOUT_MS,
          runner: scriptRunner
        })
  const updateChecker = createUpdateChecker({
    source: updateSource,
    settings,
    clock,
    currentVersion: app.getVersion(),
    defaultDir: DEFAULT_UPDATES_DIR,
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS
  })
  const programDir = resolveProgramDir(process.env, homedir())
  const updateInstaller = createUpdateInstaller({
    source: updateSource,
    scriptRunner,
    programDir,
    timeoutMs: UPDATE_INSTALL_TIMEOUT_MS,
    relauncher: {
      relaunch: (execPath) => {
        skipBusyQuitWarning()
        // The installed app must not inherit a node-mode flag from this process.
        delete process.env.ELECTRON_RUN_AS_NODE
        // In dev, electron-vite sets ELECTRON_RENDERER_URL on this process; the relaunched
        // installed app would inherit it and window.ts would load the (dead) Vite dev server
        // URL instead of its bundled renderer.
        delete process.env.ELECTRON_RENDERER_URL
        // Other electron-vite dev vars would equally leak into the installed app.
        for (const key of [
          'NODE_ENV_ELECTRON_VITE',
          'ELECTRON_ENTRY',
          'ELECTRON_EXEC_PATH',
          'ELECTRON_CLI_ARGS',
          'ELECTRON_MAJOR_VER'
        ]) {
          delete process.env[key]
        }
        if (!app.isPackaged) {
          delete process.env.NODE_ENV
        }
        // args MUST be explicit: the default re-passes process.argv (in dev, the
        // electron-vite project path).
        app.relaunch({ execPath, args: [] })
        app.quit()
      }
    }
  })
  const updateScheduler = createUpdateScheduler({
    checker: updateChecker,
    broadcast: (event) => {
      windowRegistry.broadcast(event)
      // Passive update (VDI SwiftShader): force a repaint so the popup/badge paint now,
      // same as the §9.5 toast path. Repaint only, never a raise.
      findWindow(windowIds, MAIN_WINDOW_ID)?.webContents.invalidate()
    }
  })

  registerIpcHandlers(commandLoop, deps, {
    windowIds,
    updates: { checker: updateChecker, installer: updateInstaller, scheduler: updateScheduler },
    // `onHydrate(windowId)` marks THAT window ready so its buffered startup events
    // flush exactly when its renderer can receive them (§6.7, generalizes §6.5).
    onHydrate: (windowId) => windowRegistry.markReady(windowId),
    clipboard: new ElectronClipboard(),
    jira: jiraSource,
    credentials,
    // Watch-in-place "seen" relay (§9.5): the hosting window watched a turn finish in
    // place (no focus transition to broadcast), so fan the clear out to every window's
    // ready-for-review view-model. Synthesized here (not on the bus) like the §9.5 toast.
    broadcastSessionSeen: (sessionId) =>
      windowRegistry.broadcast({ type: 'sessionSeen', sessionId }),
    // Issues drawer toggle relay (§13.4): sent only by a SECONDARY window's
    // shortcut (the main window toggles its own store locally and never calls
    // this). Relay the toggle to the main window ONLY first — never broadcast,
    // so a secondary window never opens a drawer of its own — THEN raise/focus
    // the main `BrowserWindow`, which forces the VDI repaint (same
    // passive-DOM-update stall as the §9.5 toast above, which also invalidates
    // AFTER its `sendTo`): repainting before the renderer has processed the
    // toggle risks painting the pre-toggle frame on this GPU-less host.
    toggleIssuesDrawer: () => {
      const win = findWindow(windowIds, MAIN_WINDOW_ID)
      windowRegistry.sendTo(MAIN_WINDOW_ID, { type: 'issuesDrawerToggle' })
      if (win) {
        raiseWindow(win)
      }
    }
  })

  // Async daemon warmup (§6.2). Selects the durable backend when the setting asks
  // for it AND a daemon is reachable/launchable; otherwise leaves the in-process
  // delegate untouched (degrade-to-in-process — the user-chosen fallback). Kept out
  // of `bootstrap()` (which must stay synchronous, running before `app.whenReady`);
  // the entry point awaits this at the top of `whenReady`, before any window opens.
  const warmupSessions = async (): Promise<void> => {
    if (getSettings().terminal.backend === 'in-process') {
      return // opted out → empty roster → every restored session spawns fresh.
    }
    try {
      await daemonClient.ensureReady()
    } catch (err) {
      // Daemon could be neither reached nor launched → stay in-process for this run.
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[octopus] daemon backend unavailable, using in-process PTYs: ${message}`)
      return
    }
    // Reachable: adopt the durable backend and seed the live roster from it.
    try {
      const roster = await daemonClient.listSessions()
      // The set the use-cases read to choose attach-vs-fresh: only ids the daemon
      // still holds ALIVE re-attach; a dead entry falls into the fresh-spawn path.
      const known = new Set<string>()
      for (const task of workspace.tasks()) {
        for (const session of task.sessions()) {
          known.add(session.id)
        }
      }
      for (const info of roster) {
        if (info.alive && known.has(info.sessionId)) {
          liveDaemonSessions.add(asSessionId(info.sessionId))
        } else if (!known.has(info.sessionId)) {
          // Orphan: a daemon PTY with no workspace session (task deleted while the
          // app was down, or a stale entry). Close it so its fd can't block a later
          // `git worktree remove` and it doesn't leak (§6.2 orphan reconciliation).
          void daemonClient.close(info.sessionId).catch(() => {})
        }
      }
      sessions.setDelegate(daemonSessions)
      daemonActive = true
      console.log(
        `[octopus] daemon backend active: ${liveDaemonSessions.size} live session(s) to re-attach`
      )
    } catch (err) {
      // Connected but the roster query failed — safest is to spawn fresh in-process
      // rather than half-adopt the daemon. Leave the delegate as-is.
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[octopus] daemon roster query failed, using in-process PTYs: ${message}`)
    }
  }

  // Daemon path only: start EVERY Ready task's sessions at boot, not just the one the
  // first window will focus, so a re-attached shell resumes streaming immediately and
  // the Claude state watcher's replayed status shows without waiting for the user to
  // focus the task. `startTaskSessions` (NOT `switchTask`), so no active-task pointer
  // moves and no `activeTaskChanged` fires; idempotent with the later focus switch
  // (§6.2, §9.6, §6.6 — runs on the single writer). The entry point calls this only
  // once the windows are registered: the first command runs on the next microtask and
  // publishes its restored history synchronously, and the registry drops output for a
  // window it doesn't know yet, so that pane would come up without its history.
  const startReadyTasks = (): void => {
    if (!daemonActive) {
      return
    }
    for (const task of workspace.tasks()) {
      if (task.lifecycle === TaskLifecycle.Ready) {
        void commandLoop.dispatch({ kind: 'startTaskSessions', input: { taskId: task.id } })
      }
    }
  }

  // Daemon path only: persist each live session's current cwd from the roster while
  // the socket is still up (§6.3). Best-effort — a failure just means a later fresh
  // spawn falls back to the worktree cwd, exactly as on the in-process path.
  const persistDaemonCwds = async (): Promise<void> => {
    if (!daemonActive) {
      return
    }
    try {
      const roster = await daemonClient.listSessions()
      for (const info of roster) {
        if (info.cwd) {
          try {
            deps.persistence.saveLastCwd(asSessionId(info.sessionId), info.cwd)
          } catch {
            // Best-effort per session — one bad write must not skip the rest.
          }
        }
      }
    } catch {
      // Roster query failed (daemon already gone?) — nothing to persist; the fresh
      // spawn falls back to the worktree cwd.
    }
  }

  // Control socket (design: control socket). Handlers dispatch through the SAME
  // single-writer CommandLoop as IPC; reads use the live deps. Not listening yet.
  const controlServer = createControlServer({
    socketPath: paths.controlSocketPath,
    handle: createControlHandlers({
      dispatch: (command) => commandLoop.dispatch(command),
      listProjects: () => listProjects(deps),
      getSnapshot: () => deps.workspace.toSnapshot(deps.aggregator)
    }),
    logger: {
      warn: (m, ...a) => console.warn(`[octopus] control: ${m}`, ...a),
      error: (m, ...a) => console.error(`[octopus] control: ${m}`, ...a)
    }
  })

  // Periodic flush (§6.6) so an app killed at reboot loses at most one interval of
  // output. Runs outside the CommandLoop on purpose (see flush-scrollbacks.ts).
  let storeClosed = false
  const scrollbackFlusher = createScrollbackFlushScheduler({
    flush: () => {
      if (!storeClosed) flushScrollbacks(deps, { maxBytes: SCROLLBACK_FLUSH_TICK_BYTES })
    }
  })

  return {
    paths,
    updateScheduler,
    scrollbackFlusher,
    flushScrollbacks: () => {
      if (!storeClosed) flushScrollbacks(deps)
    },
    commandLoop,
    controlServer,
    deps,
    bus,
    registry: windowRegistry,
    windowIds,
    isQuitting: false,
    warmupSessions,
    startReadyTasks,
    daemonActive: () => daemonActive,
    persistDaemonCwds,
    shutdown: () => {
      scrollbackFlusher.stop() // no tick may hit the store once it closes below
      // Stop accepting CLI requests BEFORE the loop's runtimes/store go away.
      void controlServer.close().catch(() => undefined)
      windowRegistry.dispose()
      claudeStateWatcher?.dispose()
      shutdown(deps, {
        daemonBackend: daemonActive,
        // Drop the client socket AFTER runtimes detach; the daemon reads the
        // disconnect as detach-all and keeps every PTY running (§6.2).
        onReleased: daemonActive ? () => daemonClient.dispose() : undefined
      })
      storeClosed = true
    }
  }
}
