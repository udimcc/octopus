import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { mkdirSync, chmodSync } from 'node:fs'
import { controlSocketPath, resolveDataDir } from '../../shared/data-paths'

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
   * Dir holding the generated Claude hook recorder script + per-session events logs
   * (§9). The recorder appends to `<sessionId>.events.jsonl` here; the app's watcher
   * folds them. See `octopus-claude-state.script.ts`.
   */
  claudeStateDir: string
  /**
   * Dir holding `safeStorage`-encrypted secrets, one `<ref>.bin` file per
   * `CredentialsProvider` reference (DESIGN "Jira import", I16) — e.g. the Jira API
   * key. Created with mode 0700 by {@link ensureAppDirs} since it holds encrypted
   * secrets; never readable by the DB/settings.json (I16).
   */
  credentialsDir: string
  /** Control socket for `octopus-cli` (`<dataDir>/control.sock`); ~107-byte (darwin: 103) path limit applies. */
  controlSocketPath: string
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
  const dataDir = resolveDataDir({ env, platform, home })
  return {
    dataDir,
    dbPath: join(dataDir, 'octopus.db'),
    settingsPath: join(dataDir, 'settings.json'),
    logsDir: join(dataDir, 'logs'),
    stateLogPath: join(dataDir, 'logs', 'state.log'),
    shellIntegrationDir: join(dataDir, 'shell-integration'),
    claudeStateDir: join(dataDir, 'claude-state'),
    credentialsDir: join(dataDir, 'credentials'),
    controlSocketPath: controlSocketPath(dataDir, platform)
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
  // `mode` on mkdirSync is subject to umask and is never applied to a dir that
  // already exists (e.g. carried over from an install predating this dir, or
  // created with a looser umask) — chmod explicitly so secrets are always 0700.
  // Best-effort: a chmod failure (EPERM on a dir owned by another user, or a
  // filesystem without POSIX modes) must not stop the app from starting — the
  // credentials adapter re-applies 0700 on every write anyway.
  mkdirSync(paths.credentialsDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(paths.credentialsDir, 0o700)
  } catch {
    // ignored — see above
  }
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

/** Folder `install.sh` installs the app payload into (must match `PROGRAM_DIR` there). */
const PROGRAM_DIR = 'octopus-app'

/**
 * Resolve the per-user PROGRAM dir (`$XDG_DATA_HOME/octopus-app`, default
 * `~/.local/share/octopus-app`) that `install.sh` installs into; the app binary is
 * `<programDir>/octopus`. Pure. Linux semantics, matching install.sh exactly.
 */
export function resolveProgramDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_DATA_HOME
  return join(xdg && xdg.length > 0 ? xdg : join(home, '.local', 'share'), PROGRAM_DIR)
}

/**
 * Resolve the dir the updater stages a release copy into: a sibling of the program
 * dir (`$XDG_DATA_HOME/octopus-update-staging`), so the copy lives on the program
 * dir's filesystem and never depends on a possibly-`noexec` /tmp. Pure.
 */
export function resolveUpdateStagingDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(dirname(resolveProgramDir(env, home)), 'octopus-update-staging')
}
