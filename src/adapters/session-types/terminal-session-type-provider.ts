/**
 * The Terminal `SessionTypeProvider` (DESIGN §8, §9). The only session type today.
 * `capabilities` includes `EvaluatesState` (phase 2, §9): a terminal evaluates its
 * own state (Idle/Working/Needs-input) via the composite provider its runtime
 * builds, so `stateEvaluator()` is non-null when detection is enabled.
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
import {
  Capability,
  type SessionTypeProvider
} from '../../ports/session-type-provider'

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

  /** cwd defaults to the worktree (§3.2, §6.1); shell left to the runtime fallbacks. */
  defaultConfig(worktreePath: string): SessionConfig {
    const config: TerminalSessionConfig = { kind: 'terminal', cwdOverride: worktreePath }
    return config
  }

  createRuntime(manager: SessionManager, ctx: SessionRuntimeContext): SessionRuntime {
    return manager.createRuntime(ctx)
  }
}
