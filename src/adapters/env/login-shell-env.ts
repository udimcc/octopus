import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

/**
 * Login-shell environment for GUI launches (macOS). An app started from Finder, the
 * Dock or Spotlight is spawned by launchd with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`
 * and no `LANG`: Homebrew's `git`, `node`, `claude`, … are invisible to worktree
 * scripts, to `octopusd` (which inherits this process's env, §6.2) and to every
 * session PTY built from it (§6.1). So, on darwin only, run the user's shell once as
 * an interactive login shell, read the `PATH` (and `LANG`/`LC_ALL`) it ends up with,
 * and merge them into `process.env` FIRST in bootstrap, before the daemon can be
 * spawned or the Claude hooks are installed.
 *
 * Pure parser/merge + one effectful wrapper ({@link applyLoginShellEnv}), as in
 * `paths.ts`. Best-effort: any failure (timeout, odd shell, no output) leaves the
 * env untouched and is only logged.
 *
 * The rule is "always merge on darwin", also when launched from a terminal: the
 * login-shell entries go first, the inherited ones follow, duplicates dropped. A
 * terminal launch thus loses nothing; only the order of already-present entries
 * may change.
 */

/** Marks the probe output so rc-file noise (banners, `echo`s) around it is ignored. */
export const LOGIN_ENV_SENTINEL = '__OCTOPUS_LOGIN_ENV_7f3a__'

/** A slow rc file must not stall boot for long. */
export const LOGIN_SHELL_TIMEOUT_MS = 3000

/** Vars read back from the login shell. */
const PROBED_VARS = ['PATH', 'LANG', 'LC_ALL'] as const
type ProbedVar = (typeof PROBED_VARS)[number]
export type LoginShellEnv = Partial<Record<ProbedVar, string>>

/**
 * The `-c` command. `printf` and `/usr/bin/env` behave the same under sh, bash,
 * zsh and fish, so no shell-specific quoting or `${VAR-}` syntax is needed.
 */
export function loginShellProbeCommand(sentinel: string = LOGIN_ENV_SENTINEL): string {
  return `printf '\\n%s\\n' '${sentinel}'; /usr/bin/env; printf '\\n%s\\n' '${sentinel}'`
}

/**
 * Extract {@link PROBED_VARS} from the probe's stdout: only the `env` lines between
 * the first two sentinels count. Empty values are dropped. Returns `undefined` when
 * the sentinels are missing (the shell never ran the command).
 */
export function parseLoginShellEnv(
  stdout: string,
  sentinel: string = LOGIN_ENV_SENTINEL
): LoginShellEnv | undefined {
  const start = stdout.indexOf(sentinel)
  if (start === -1) return undefined
  const end = stdout.indexOf(sentinel, start + sentinel.length)
  if (end === -1) return undefined
  const out: LoginShellEnv = {}
  for (const line of stdout.slice(start + sentinel.length, end).split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if ((PROBED_VARS as readonly string[]).includes(key) && value.length > 0) {
      out[key as ProbedVar] = value
    }
  }
  return out
}

/** Union of two `:`-separated PATH lists: `first`'s entries first, duplicates/empties dropped. */
export function mergePathLists(first: string | undefined, second: string | undefined): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of [first, second]) {
    for (const entry of (list ?? '').split(':')) {
      if (entry.length === 0 || seen.has(entry)) continue
      seen.add(entry)
      out.push(entry)
    }
  }
  return out.join(':')
}

/**
 * The env patch to apply: the merged `PATH`, plus `LANG`/`LC_ALL` only where the
 * current env has none (an explicitly inherited locale always wins).
 */
export function loginShellEnvPatch(
  current: Readonly<Record<string, string | undefined>>,
  probed: LoginShellEnv
): Record<string, string> {
  const patch: Record<string, string> = {}
  if (probed.PATH !== undefined) {
    const merged = mergePathLists(probed.PATH, current.PATH)
    if (merged !== current.PATH) patch.PATH = merged
  }
  for (const key of ['LANG', 'LC_ALL'] as const) {
    const value = probed[key]
    if (value !== undefined && (current[key] ?? '') === '') patch[key] = value
  }
  return patch
}

/** Pick the shell to probe: `$SHELL`, else the account's shell, else `/bin/zsh`. */
export function probeShell(envShell: string | undefined, accountShell: string | undefined): string {
  for (const s of [envShell, accountShell]) {
    if (s !== undefined && s.startsWith('/')) return s
  }
  return '/bin/zsh'
}

export interface ApplyLoginShellEnvDeps {
  /** Mutated in place (normally `process.env`). */
  readonly env: Record<string, string | undefined>
  /** Runs `shell args` and returns stdout; throws on failure/timeout. Injected for tests. */
  readonly run?: (shell: string, args: readonly string[], timeoutMs: number) => string
  readonly accountShell?: () => string | undefined
}

export interface ApplyLoginShellEnvResult {
  readonly applied: boolean
  /** Keys changed in `env`. */
  readonly keys: readonly string[]
  readonly message: string
}

const runShell = (shell: string, args: readonly string[], timeoutMs: number): string =>
  execFileSync(shell, [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    // No TTY: an interactive shell must not wait on stdin.
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 4 * 1024 * 1024
  })

const defaultAccountShell = (): string | undefined => {
  try {
    return userInfo().shell ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Probe the login shell and merge its PATH/locale into `deps.env`. Never throws.
 * The caller gates it on the host profile's `proc.adoptLoginShellEnv` (macOS only;
 * Linux behavior unchanged).
 */
export function applyLoginShellEnv(deps: ApplyLoginShellEnvDeps): ApplyLoginShellEnvResult {
  const shell = probeShell(deps.env.SHELL, (deps.accountShell ?? defaultAccountShell)())
  let stdout: string
  try {
    stdout = (deps.run ?? runShell)(
      shell,
      ['-ilc', loginShellProbeCommand()],
      LOGIN_SHELL_TIMEOUT_MS
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { applied: false, keys: [], message: `${shell} -ilc failed: ${message}` }
  }
  const probed = parseLoginShellEnv(stdout)
  if (probed === undefined) {
    return { applied: false, keys: [], message: `${shell} -ilc printed no environment` }
  }
  const patch = loginShellEnvPatch(deps.env, probed)
  Object.assign(deps.env, patch)
  const keys = Object.keys(patch)
  return {
    applied: keys.length > 0,
    keys,
    message:
      keys.length > 0 ? `merged ${keys.join(', ')} from ${shell}` : `nothing to merge (${shell})`
  }
}
