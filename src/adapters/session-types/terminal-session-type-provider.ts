/**
 * The Terminal `SessionTypeProvider` (DESIGN §8, §10 V1). The only session type
 * in V1. `capabilities` is deliberately EMPTY — Terminal does not have
 * `EvaluatesState`, so it emits no state signals and `stateEvaluator()` is null
 * (§10 V1 seam). `availableFromVersion = 1` so it shows in the dropdown from V1.
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
  /** Empty in V1: Terminal has no `EvaluatesState` (§10). */
  readonly capabilities: ReadonlySet<Capability> = new Set()

  /** cwd defaults to the worktree (§3.2, §6.1); shell left to the runtime fallbacks. */
  defaultConfig(worktreePath: string): SessionConfig {
    const config: TerminalSessionConfig = { kind: 'terminal', cwdOverride: worktreePath }
    return config
  }

  createRuntime(manager: SessionManager, ctx: SessionRuntimeContext): SessionRuntime {
    return manager.createRuntime(ctx)
  }
}
