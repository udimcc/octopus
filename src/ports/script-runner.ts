/**
 * Port for running external user scripts (DESIGN §6.4, I17). User scripts and
 * terminal commands are a TRUST BOUNDARY: the runner takes an explicit command
 * and an ARGV ARRAY — never a shell string — so untrusted task/branch names are
 * never interpolated into a shell (I17, R3). It enforces cwd, env, a timeout
 * (SIGTERM → grace → SIGKILL), and captures exit code + size-capped stderr.
 */

export interface ScriptRunOptions {
  /** Working directory for the child (e.g. $OCTOPUS_REPO_ROOT for create). */
  readonly cwd: string
  /** Extra environment on top of the inherited env (OCTOPUS_* vars). */
  readonly env?: Readonly<Record<string, string>>
  /** Kill the child after this many ms (default 30 000 for worktree scripts). */
  readonly timeoutMs?: number
  /** Grace period between SIGTERM and SIGKILL (default 2000). */
  readonly graceMs?: number
  /** Cap captured stderr at this many bytes (default 64 KiB, §6.4). */
  readonly maxStderrBytes?: number
  /**
   * Spawn in its own process group and signal the whole group on timeout, so
   * grandchildren (e.g. a script's foreground `cp`) die too. Default false.
   */
  readonly killProcessGroup?: boolean
  /** Called per complete stdout line (§6.4: create-script's path lands here). */
  readonly onStdoutLine?: (line: string) => void
  /**
   * Called per complete stderr line. Worktree scripts route diagnostics to
   * stderr (§6.4), so this is the streaming-progress channel; stdout is reserved
   * for the machine-readable path.
   */
  readonly onStderrLine?: (line: string) => void
}

export interface ScriptResult {
  /** Process exit code, or null if terminated by a signal. */
  readonly exitCode: number | null
  /** Signal that terminated the process, if any (e.g. 'SIGKILL' on timeout). */
  readonly signal: NodeJS.Signals | null
  /** Full stdout (also delivered line-by-line via `onStdoutLine`). */
  readonly stdout: string
  /** Captured stderr, truncated to `maxStderrBytes`. */
  readonly stderr: string
  /** True if the child was killed because it exceeded `timeoutMs`. */
  readonly timedOut: boolean
}

export interface ScriptRunner {
  /**
   * Run `command` with `args` (argv, no shell). Resolves with the captured
   * result once the child exits or is killed; rejects only on spawn failure
   * (e.g. ENOENT), not on a non-zero exit.
   */
  run(command: string, args: readonly string[], opts: ScriptRunOptions): Promise<ScriptResult>
}
