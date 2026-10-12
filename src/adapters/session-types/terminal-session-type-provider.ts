/**
 * The Terminal `SessionTypeProvider` (DESIGN §8, §9). The only session type today.
 * `capabilities` includes `EvaluatesState` (§9): a terminal running Claude surfaces
 * its state (Idle/Working/Needs-input), though the signal now flows out-of-band —
 * the Claude hook recorder appends to each session's events log and a single app-side
 * watcher feeds the Application (§9.6), not a per-runtime evaluator method.
 * `availableFromVersion = 1` so it shows in the dropdown from the first version.
 *
 * `createRuntime` delegates to the injected `SessionManager` (the PTY manager at
 * the composition root) — the provider owns type identity + config, the manager
 * owns the concrete runtime, per §8's behavior/rendering split.
 */

import { asTypeId, type TypeId } from '../../domain/ids'
import type { SessionConfig, TerminalSessionConfig } from '../../domain/session-config'
import type {
  SessionManager,
  SessionRuntime,
  SessionRuntimeContext
} from '../../ports/session-runtime'
import { Capability, type SessionTypeProvider } from '../../ports/session-type-provider'

export const TERMINAL_TYPE_ID: TypeId = asTypeId('terminal')

/**
 * JSON Schema for `TerminalSessionConfig` (§8). Drives ajv validation in V1 (the
 * dormant validate seam) and the New-Session config dialog in a later version.
 */
const TERMINAL_CONFIG_SCHEMA: object = {
  type: 'object',
  properties: {
    kind: { const: 'terminal' },
    shell: { type: 'string' },
    initialCommand: { type: 'string' },
    cwdOverride: { type: 'string' }
  },
  required: ['kind'],
  additionalProperties: false
}

export class TerminalSessionTypeProvider implements SessionTypeProvider {
  readonly typeId = TERMINAL_TYPE_ID
  readonly displayName = 'Terminal'
  readonly icon = 'terminal'
  readonly availableFromVersion = 1
  readonly configSchema = TERMINAL_CONFIG_SCHEMA
  /** Terminal evaluates its own state (§9): the runtime exposes a state evaluator. */
  readonly capabilities: ReadonlySet<Capability> = new Set([Capability.EvaluatesState])

  /**
   * cwd defaults to the worktree (§3.2, §6.1); shell left to the runtime fallbacks.
   * With no worktree ("No Repo" task, §5.4) the config carries no `cwdOverride`, so
   * the runtime opens the session at the home dir.
   */
  defaultConfig(worktreePath?: string): SessionConfig {
    const config: TerminalSessionConfig = worktreePath
      ? { kind: 'terminal', cwdOverride: worktreePath }
      : { kind: 'terminal' }
    return config
  }

  createRuntime(manager: SessionManager, ctx: SessionRuntimeContext): SessionRuntime {
    return manager.createRuntime(ctx)
  }
}
