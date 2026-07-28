/**
 * The composition root (DESIGN §2): the ONLY place that knows concrete adapters
 * and wires them to the ports the application depends on. Localizing the
 * Electron/node-pty/SQLite choices here is what lets the domain stay pure and the
 * edges stay swappable — no other layer imports an adapter (boundary rule).
 *
 * Bootstrap order (V0 order preserved, extended):
 *   1. `raiseFileLimit()` FIRST — child PTYs inherit the higher soft fd limit (§6.1).
 *   2. `ensureAppDirs()` — data + logs dirs exist before any store opens.
 *   3. Build adapters behind their ports (clock, ids, bus, settings, persistence,
 *      script runner, worktree provider, socket provisioner, PTY manager, session-
 *      type registry + Terminal provider, ajv config validator).
 *   4. `persistence.load()` → `Workspace.hydrate` → `reconcileOnStartup` (missing
 *      worktree → Stale, I14).
 *   5. `new CommandLoop(deps)`; late-bind `deps.onRuntimeExit` to route a runtime's
 *      spontaneous exit back through the loop as `handleRuntimeExit` (single-writer,
 *      §6.6).
 *   6. Create the window registry (event router) + register IPC handlers.
 *
 * Returns an `AppContext` the entry point (`index.ts`/`window.ts`) uses to open a
 * window, forward events, and shut down cleanly (§6.3 quit).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { raiseFileLimit } from '../adapters/env/raise-file-limit'
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
import { createSocketProvisioner } from '../adapters/state-socket/socket-provisioner'
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
import { createAjvConfigValidator } from '../application/config-validator'
import { MapRuntimeRegistry, type AppDependencies } from '../application/dependencies'
import { CommandLoop } from '../application/command-loop'
import { reconcileOnStartup } from '../application/reconcile'
import { shutdown } from '../application/quit'
import { worstStatusWins } from '../domain/task-state-aggregator'
import { Workspace } from '../domain/workspace'
import type { Settings } from '../ports/settings-store'
import type { EventBus } from '../ports/event-bus'
import { MAIN_WINDOW_ID, asSessionId, type SessionId, type WindowId } from '../domain/ids'
import { locateSession } from '../application/use-cases/locate-session'
import { CURRENT_VERSION } from '../shared/version'
import { registerIpcHandlers } from './ipc-handlers'
import { createWindowRegistry, type WindowRegistry } from './window-registry'

export interface AppContext {
  readonly paths: AppPaths
  readonly commandLoop: CommandLoop
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

export function bootstrap(): AppContext {
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

  const socketProvisioner = createSocketProvisioner(getUid())

  // Session backend (§6.2). We ALWAYS start on the in-process PTY manager and,
  // unless `terminal.backend === 'in-process'`, swap to the durable daemon backend
  // during the async `warmupSessions()` below — but only once a reachable `octopusd`
  // is confirmed. The daemon is the DEFAULT: only an explicit `'in-process'` opts out.
  // This honors the chosen fallback: if the daemon can be neither reached nor launched,
  // the switchable manager simply stays in-process for the run. Wiring the daemon
  // client here (not connecting) keeps `bootstrap()` synchronous.
  const inProcessSessions = new PtySessionManager({ getSettings })
  const sessions = new SwitchableSessionManager(inProcessSessions)
  const daemonClient = new DaemonClient({
    socketPath: controlSocketPath(currentUid()),
    daemonEntry: join(__dirname, 'daemon.js'),
    daemonVersion: CURRENT_VERSION.toString()
  })
  const daemonSessions = new DaemonSessionManager({ client: daemonClient, getSettings })
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
  // `session_scrollback` on quit/exit, replayed into the fresh PTY on restart.
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
    socketProvisioner,
    scrollbacks,
    currentVersion: CURRENT_VERSION,
    // Live at construction: the SAME Set instance the warmup fills before any
    // session starts (use-cases read it lazily via `has`, §6.2).
    liveDaemonSessions
  }

  reconcileOnStartup(deps, { existsDir })

  // 5. Command loop; late-bind the spontaneous-exit sink to re-enter the loop
  //    (so `markExited` runs on the single writer, never inline in a PTY callback).
  const commandLoop = new CommandLoop(deps)
  deps.onRuntimeExit = (sessionId, exitCode, signal): void => {
    void commandLoop.dispatch({
      kind: 'handleRuntimeExit',
      input: { sessionId, exitCode, signal }
    })
  }

  // 6. Window registry + IPC handlers (§6.7). The registry routes each event to the
  //    window(s) that should see it; `resolveSessionWindow` looks up a session's
  //    current window via the live workspace (undefined once it's removed → the
  //    registry broadcasts, so a just-closed tab's event still reaches its window).
  const windowRegistry = createWindowRegistry(bus, (sessionId) => {
    const located = locateSession(workspace, asSessionId(sessionId))
    return located?.session.windowId
  })

  // webContents.id → WindowId, filled as windows open (backs windowAtPoint +
  // per-window markReady). Mutated by the entry point/window.ts as windows appear.
  const windowIds = new Map<number, WindowId>()

  // `onHydrate(windowId)` marks THAT window ready so its buffered startup events
  // flush exactly when its renderer can receive them (§6.7, generalizes §6.5).
  registerIpcHandlers(commandLoop, deps, {
    windowIds,
    onHydrate: (windowId) => windowRegistry.markReady(windowId)
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

  return {
    paths,
    commandLoop,
    deps,
    bus,
    registry: windowRegistry,
    windowIds,
    isQuitting: false,
    warmupSessions,
    daemonActive: () => daemonActive,
    persistDaemonCwds,
    shutdown: () => {
      windowRegistry.dispose()
      shutdown(deps, {
        daemonBackend: daemonActive,
        // Drop the client socket AFTER runtimes detach; the daemon reads the
        // disconnect as detach-all and keeps every PTY running (§6.2).
        onReleased: daemonActive ? () => daemonClient.dispose() : undefined
      })
    }
  }
}

/** Current uid for the socket dir; 0 on platforms without `process.getuid`. */
function getUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}
