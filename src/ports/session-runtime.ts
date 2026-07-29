/**
 * `SessionRuntime` / `SessionManager` ports (DESIGN §6.2, §8). The runtime is
 * the type-neutral handle to a live session (a PTY in V1). The renderer talks
 * only to this interface, so a V2 durable backend (daemon/tmux) is a drop-in
 * `SessionManager` swap with no renderer change (§6.2).
 *
 * `stateEvaluator()` is the §10 V1 seam: it returns null for a terminal (which
 * lacks `EvaluatesState`). V2 returns a real evaluator here; the signature does
 * not change.
 */

import type { TaskId, SessionId } from '../domain/ids'

/** An opaque per-session state evaluator (V2). Shape defined later; null in V1. */
export type StateEvaluator = unknown

/** Everything a runtime needs to start a session (DESIGN §6.1). */
export interface SessionRuntimeContext {
  readonly taskId: TaskId
  readonly sessionId: SessionId
  /** cwd for the process: the task's worktree path (or cwdOverride). */
  readonly worktreePath: string
  readonly cols: number
  readonly rows: number
  /** Base environment to sanitize + extend (OCTOPUS_* vars added by the adapter). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Shell override (else $SHELL, else /bin/bash) (§6.1). */
  readonly shell?: string
  /**
   * The per-session state socket path (§9.2). Provisioned in V1 but never bound;
   * exported to the child as OCTOPUS_STATE_SOCKET (§10 V1 seam).
   */
  readonly stateSocketPath?: string
  /**
   * Re-attach hint for a durable backend (§6.2). When true, a session already
   * lives in the daemon and `start()` should RE-ATTACH (replaying its live buffer)
   * rather than spawn a fresh process — this is what carries cwd, running programs,
   * and scrollback across an app restart. The in-process `PtyTerminalRuntime`
   * ignores it and always spawns fresh (the correct no-daemon fallback). Absent/
   * false everywhere preserves V1 behavior exactly (§10 additive seam).
   */
  readonly resume?: boolean
  /** Called with each batch of terminal output (§6.5 batching happens in the adapter). */
  readonly onData: (data: string) => void
  /** Called once when the process exits (§6.1); drives markExited via the command loop. */
  readonly onExit: (exitCode?: number, signal?: number) => void
}

export interface SessionRuntime {
  /** Spawn the process. Rejects → session goes `StartFailed` (§3.6). */
  start(): Promise<void>
  /** Write user input to the process (keystrokes). */
  write(data: string): void
  /** Resize the terminal (→ TIOCSWINSZ → SIGWINCH) (§6.1). */
  resize(cols: number, rows: number): void
  /** Graceful close: SIGHUP, then SIGKILL after a grace period (§6.1). */
  stop(): Promise<void>
  /** Release resources without signalling (used after an observed exit). */
  dispose(): void
  /** V2 seam: returns null in V1 (Terminal has no `EvaluatesState`) (§10). */
  stateEvaluator(): StateEvaluator | null
  /**
   * Best-effort current working directory of the live process (§6.1) — where a
   * terminal has `cd`'d to since spawn, used to open a new session in the same
   * directory. Optional §10 seam: a runtime that can't observe it (or a
   * non-terminal type) omits the method; callers treat absence as "unavailable".
   * Returns `undefined` for an exited/never-started session.
   */
  currentCwd?(): Promise<string | undefined>
}

export interface SessionManager {
  /** Create (not yet started) a runtime for the given context (§8 factory). */
  createRuntime(ctx: SessionRuntimeContext): SessionRuntime
}
