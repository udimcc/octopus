import { ipcMain } from 'electron'
import { raiseFileLimit } from '../adapters/env/raise-file-limit'
import { ensureAppDirs, type AppPaths } from '../adapters/env/paths'
import { CHANNELS } from '../shared/ipc'

/**
 * The composition root (DESIGN §2): the ONLY place that knows concrete adapters
 * and wires them to the ports the application depends on. Localizing the
 * Electron/node-pty/SQLite choices here is what lets the domain stay pure and
 * the edges stay swappable.
 *
 * V0 only prepares the runtime environment and registers the health-check IPC
 * handler. V1 instantiates the real adapters here (SqliteStore,
 * PtyTerminalRuntime, ShellScriptWorktreeProvider, ...) behind their ports and
 * hands them to the application use-cases.
 */
export interface AppContext {
  paths: AppPaths
}

export function bootstrap(): AppContext {
  // Order matters: raise the fd limit FIRST so any child process spawned later
  // (V1 PTYs) inherits the higher soft limit (DESIGN §6.1).
  const rlimit = raiseFileLimit()
  console.log(`[octopus] RLIMIT_NOFILE: ${rlimit.message}`)

  const paths = ensureAppDirs()
  console.log(`[octopus] data dir ensured at ${paths.dataDir}`)

  registerIpcHandlers()

  return { paths }
}

function registerIpcHandlers(): void {
  // V0 health check — proves the preload contextBridge round-trips to main.
  ipcMain.handle(CHANNELS.ping, () => 'pong')
}
