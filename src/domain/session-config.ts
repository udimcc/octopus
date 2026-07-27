/**
 * Per-session configuration (DESIGN §3.2). `SessionConfig` must be fully
 * serializable so a session can be recreated from persistence on restart (I15).
 * The domain treats a config as opaque, already-validated data — validation
 * against the session type's `configSchema` happens in the application layer
 * (ajv), keeping the domain free of a schema-validation dependency (§10 seam).
 *
 * The union is `kind`-discriminated so V3's Jenkins config is purely additive.
 */

/** Terminal session config. All fields optional; cwd defaults to the worktree. */
export interface TerminalSessionConfig {
  readonly kind: 'terminal'
  /** Override shell; else settings.terminal.shell, else $SHELL, else /bin/bash (§6.1). */
  readonly shell?: string
  /** A command written to the PTY once the shell is ready. */
  readonly initialCommand?: string
  /** Override cwd; defaults to the task's worktree path (§3.2, §6.1). */
  readonly cwdOverride?: string
}

/**
 * Discriminated union of all session configs. V1 has only `terminal`; V3 adds a
 * `jenkins` member here (`{ kind: 'jenkins', jobPath, branch?, credentialsRef }`)
 * with no change to existing members.
 */
export type SessionConfig = TerminalSessionConfig
