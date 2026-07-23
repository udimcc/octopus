/**
 * Narrow, total accessors over the opaque `SessionConfig` union (DESIGN §3.2).
 * The domain treats a config as already-validated opaque data; these helpers pull
 * the terminal-specific fields the runtime needs without the use-cases pattern-
 * matching on `kind` inline. V1 has only the terminal kind, but they stay total so
 * V3's Jenkins config is additive (each returns `undefined` for a non-terminal).
 */

import type { SessionConfig, TerminalSessionConfig } from '../../domain/session-config'

export function asTerminal(config: SessionConfig): TerminalSessionConfig | undefined {
  return config.kind === 'terminal' ? config : undefined
}

export function configCwd(config: SessionConfig): string | undefined {
  return asTerminal(config)?.cwdOverride
}

export function configShell(config: SessionConfig): string | undefined {
  return asTerminal(config)?.shell
}

export function configInitialCommand(config: SessionConfig): string | undefined {
  return asTerminal(config)?.initialCommand
}
