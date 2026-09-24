/**
 * Pure PTY environment + shell resolution (DESIGN §6.1). Lives in `shared` (not
 * `adapters`) so BOTH the in-process PTY runtime and the out-of-process `octopusd`
 * daemon (§6.2) build the child env from the same code — the daemon may import
 * only `shared`, never `adapters` (boundary rule). Ids are plain `string`s here
 * (the `shared` convention: it must not import `domain`); the branded `TaskId`/
 * `SessionId` the callers hold are assignable to `string`.
 *
 * §6.1 env recipe:
 *   { ...inherited (sanitized), TERM: 'xterm-256color', COLORTERM: 'truecolor',
 *     OCTOPUS_TASK_ID, OCTOPUS_SESSION_ID, OCTOPUS_WORKTREE }
 *   stripped: TMUX, TMUX_PANE, STY, WINDOWID.
 *
 * OCTOPUS_SESSION_ID is load-bearing for state detection (§9.6): the Claude python
 * bridge keys each session's state file by it, so it must equal `session.id`.
 *
 * Pure, no I/O — fully unit-testable and safe under both TS projects (no `Buffer`
 * or node types, so it compiles under `tsconfig.web` too).
 */

/** Multiplexer/terminal identity vars that must not leak into a fresh PTY (§6.1). */
const STRIPPED_VARS = ['TMUX', 'TMUX_PANE', 'STY', 'WINDOWID'] as const

/**
 * Env vars that identify the user's CURRENT desktop/login session rather than the
 * machine or the account — display, auth cookie, session bus, agent sockets.
 *
 * They matter because `octopusd` is deliberately long-lived (§6.2) and builds each
 * child's env from its OWN `process.env`, which is the right base for everything
 * stable (PATH, HOME, locale) and exactly wrong for these: a daemon started before a
 * logout keeps handing out the DEAD session's `DISPLAY`, `XAUTHORITY`,
 * `DBUS_SESSION_BUS_ADDRESS` and `SSH_AUTH_SOCK` to every shell spawned afterwards, so
 * GUI tools (`emacsclient -c`, `xdg-open`), notifications and agent-based git pushes
 * fail in a terminal that otherwise looks fine.
 *
 * The app process, by contrast, is launched FROM the live session, so its values are
 * current — {@link sessionScopedEnv} forwards them with `spawn` to override the
 * daemon's stale copy. Only vars actually present in the app's env are forwarded: a
 * missing one means "no opinion", not "unset it".
 *
 * Already-running PTYs keep the env they were forked with; a process's environment
 * cannot be rewritten from outside, so this fixes new sessions only.
 */
const SESSION_SCOPED_VARS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_CLASS',
  'XDG_SEAT',
  'XDG_VTNR',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID'
] as const

/**
 * The subset of `env` naming the current login session (see {@link SESSION_SCOPED_VARS}),
 * shaped as an env patch to layer over a long-lived host's stale values.
 */
export function sessionScopedEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const patch: Record<string, string> = {}
  for (const key of SESSION_SCOPED_VARS) {
    const value = env[key]
    if (value !== undefined && value.length > 0) {
      patch[key] = value
    }
  }
  return patch
}

export interface PtyEnvContext {
  readonly taskId: string
  readonly sessionId: string
  readonly worktreePath: string
}

/**
 * Build the child environment: sanitize the inherited env (drop multiplexer
 * vars), then layer the terminal + OCTOPUS_* vars on top. `undefined` inherited
 * values are dropped so they never stringify to the literal "undefined".
 */
export function buildPtyEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  ctx: PtyEnvContext
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) {
      continue
    }
    if ((STRIPPED_VARS as readonly string[]).includes(key)) {
      continue
    }
    env[key] = value
  }

  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.OCTOPUS_TASK_ID = ctx.taskId
  env.OCTOPUS_SESSION_ID = ctx.sessionId
  env.OCTOPUS_WORKTREE = ctx.worktreePath
  return env
}

/**
 * Resolve the shell to spawn (§6.1): explicit override, else the setting, else
 * $SHELL, else /bin/bash. Empty strings are treated as unset so a blank setting
 * doesn't yield an unspawnable "".
 */
export function resolveShell(
  override: string | undefined,
  settingShell: string | undefined,
  envShell: string | undefined
): string {
  return firstNonEmpty(override, settingShell, envShell) ?? '/bin/bash'
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (v !== undefined && v.length > 0) {
      return v
    }
  }
  return undefined
}
