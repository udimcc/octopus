import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Resolves Octopus's on-disk data locations (DESIGN §6.3).
 *
 * DESIGN mandates the SQLite DB at `$XDG_DATA_HOME/octopus/` on Linux
 * (`%APPDATA%\octopus\` on Windows) and logs under the same data dir. This is
 * deliberately NOT Electron's `app.getPath('userData')`, which resolves to
 * `~/.config/octopus` — the XDG *config* dir, not the *data* dir.
 *
 * The resolver is a pure function of (env, platform, home) so it is unit-testable
 * without Electron or the real filesystem; {@link ensureAppDirs} performs the
 * side-effecting directory creation.
 *
 * V0 note: nothing consumes these paths yet (the DB and log writers land in V1/V2).
 * We resolve and create the directories now so the runtime environment is ready.
 */

const APP_DIR = 'octopus'

export interface AppPaths {
  /** Root data directory for this app. */
  dataDir: string
  /** SQLite database file (created by SqliteStore in V1). */
  dbPath: string
  /** Global settings.json sibling file (DESIGN §6.3, §6.4). */
  settingsPath: string
  /** Directory for logs, incl. the V2 state-transition log (DESIGN §11). */
  logsDir: string
}

export interface ResolveContext {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
}

/**
 * Compute app paths for a given environment. Pure — no filesystem access.
 */
export function resolveAppPaths({ env, platform, home }: ResolveContext): AppPaths {
  const dataDir = join(baseDataDir(env, platform, home), APP_DIR)
  return {
    dataDir,
    dbPath: join(dataDir, 'octopus.db'),
    settingsPath: join(dataDir, 'settings.json'),
    logsDir: join(dataDir, 'logs')
  }
}

/**
 * Resolve app paths for the current process (convenience wrapper).
 */
export function currentAppPaths(): AppPaths {
  return resolveAppPaths({ env: process.env, platform: process.platform, home: homedir() })
}

/**
 * Create the data and logs directories if they do not exist. Idempotent.
 * Returns the resolved paths so callers can log where data lives.
 */
export function ensureAppDirs(paths: AppPaths = currentAppPaths()): AppPaths {
  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(paths.logsDir, { recursive: true })
  return paths
}

/** Platform base data dir per the XDG Base Directory spec / Windows convention. */
function baseDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') {
    return env.APPDATA && env.APPDATA.length > 0 ? env.APPDATA : join(home, 'AppData', 'Roaming')
  }
  // Linux/macOS: honour XDG_DATA_HOME when set to an absolute path, else the spec default.
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.startsWith('/')) {
    return xdg
  }
  return join(home, '.local', 'share')
}
