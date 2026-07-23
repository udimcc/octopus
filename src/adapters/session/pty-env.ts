/**
 * Pure PTY environment + shell resolution (DESIGN §6.1). Extracted from the
 * runtime so the exact env a shell is spawned with — and the multiplexer-var
 * stripping that keeps nested sessions sane — is unit-testable without spawning
 * anything.
 *
 * §6.1 env recipe:
 *   { ...inherited (sanitized), TERM: 'xterm-256color', COLORTERM: 'truecolor',
 *     OCTOPUS_TASK_ID, OCTOPUS_SESSION_ID, OCTOPUS_WORKTREE,
 *     OCTOPUS_STATE_SOCKET (§9.2, provisioned-not-bound in V1) }
 *   stripped: TMUX, STY, WINDOWID.
 */

import type { TaskId, SessionId } from '../../domain/ids'

/** Multiplexer/terminal identity vars that must not leak into a fresh PTY (§6.1). */
const STRIPPED_VARS = ['TMUX', 'TMUX_PANE', 'STY', 'WINDOWID'] as const

export interface PtyEnvContext {
  readonly taskId: TaskId
  readonly sessionId: SessionId
  readonly worktreePath: string
  /** Provisioned-not-bound state socket path (§9.2, §10 V1 seam). Optional. */
  readonly stateSocketPath?: string
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
  if (ctx.stateSocketPath !== undefined) {
    // Exported but never listened on in V1 (§9.2 / §10 V1 seam).
    env.OCTOPUS_STATE_SOCKET = ctx.stateSocketPath
  }
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
