import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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
  /** Directory for logs, incl. the state-transition log (DESIGN §11). */
  logsDir: string
  /** State-transition log file (JSONL, §11/R1) — one line per session-state change. */
  stateLogPath: string
  /** Dir holding the generated OSC 133 shell-integration rc files (§12.1). */
  shellIntegrationDir: string
  /**
   * Dir holding the generated Claude state bridge script + per-session state files
   * (§9). The python bridge writes `<sessionId>.json` here; the app's watcher reads
   * them. See `octopus-claude-state.script.ts`.
   */
  claudeStateDir: string
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
    logsDir: join(dataDir, 'logs'),
    stateLogPath: join(dataDir, 'logs', 'state.log'),
    shellIntegrationDir: join(dataDir, 'shell-integration'),
    claudeStateDir: join(dataDir, 'claude-state')
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
  mkdirSync(paths.claudeStateDir, { recursive: true })
  return paths
}

/** The folder name for the default native-worktree base dir (§6.4). */
const WORKTREE_DIR = 'octopus_repos'

/**
 * Resolve the base dir for native (script-less) worktrees (DESIGN §6.4). Pure —
 * no filesystem access. `configured` is the (possibly empty / relative)
 * `settings.worktree.location`; an empty or non-absolute value falls back to the
 * home-based default `~/octopus_repos`, so a hand-edited relative path can never
 * scatter worktrees under an unpredictable cwd.
 */
export function resolveWorktreeBase(configured: string | undefined, home: string): string {
  if (configured && isAbsolute(configured)) {
    return configured
  }
  return join(home, WORKTREE_DIR)
}

/** Convenience: the default native-worktree base for the current user's home. */
export function resolveDefaultWorktreeBase(home: string = homedir()): string {
  return resolveWorktreeBase(undefined, home)
}

/**
 * Create the native-worktree base dir if it does not exist. Idempotent. Native
 * `git worktree add` will not create the base dir's parent, so we ensure it up
 * front; the effectful counterpart to {@link resolveWorktreeBase}.
 */
export function ensureWorktreeBase(base: string): string {
  mkdirSync(base, { recursive: true })
  return base
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
