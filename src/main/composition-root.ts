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
import { MAIN_WINDOW_ID, asSessionId, type WindowId } from '../domain/ids'
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
  /** Graceful teardown: SIGHUP runtimes + checkpoint/close the store (I13, §6.3). */
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
  const sessions = new PtySessionManager({ getSettings })

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
    currentVersion: CURRENT_VERSION
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

  return {
    paths,
    commandLoop,
    deps,
    bus,
    registry: windowRegistry,
    windowIds,
    isQuitting: false,
    shutdown: () => {
      windowRegistry.dispose()
      shutdown(deps)
    }
  }
}

/** Current uid for the socket dir; 0 on platforms without `process.getuid`. */
function getUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}
