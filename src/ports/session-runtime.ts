/**
 * `SessionRuntime` / `SessionManager` ports (DESIGN §6.2, §8). The runtime is
 * the type-neutral handle to a live session (a PTY in V1). The renderer talks
 * only to this interface, so a V2 durable backend (daemon/tmux) is a drop-in
 * `SessionManager` swap with no renderer change (§6.2).
 *
 * `stateEvaluator()` is the §8/§10 seam: it returns null for a runtime whose type
 * lacks `EvaluatesState`, else a {@link StateEvaluator} that PUSHES state changes.
 * The signature does not change across backends — both the in-process composite
 * and the daemon's `state`-message adapter satisfy it (§9.6), so the Application
 * never learns which backend produced a signal.
 */

import type { TaskId, SessionId } from '../domain/ids'
import type { SessionState, SessionSubState } from '../domain/state'

/**
 * Metadata accompanying a state change (§9.1, §9.3). All optional: the aggregation
 * lattice only needs the {@link SessionState}, but the sub-state / confidence /
 * layer feed the debug overlay and the UI's low-confidence dimming (R1).
 */
export interface StateChangeMeta {
  readonly subState?: SessionSubState
  /** Which signal layer decided this (§9.1): 1 = activity, 2 = structural, 3 = explicit. */
  readonly layer?: 1 | 2 | 3
  /** Provider-supplied confidence (§9.3); the UI dims Medium/Low. */
  readonly confidence?: 'authoritative' | 'high' | 'medium' | 'low' | 'none'
  /** Free-form reason for the transition log (e.g. `claude_stop`, `subprocess`). */
  readonly reason?: string
}

/**
 * A per-session state evaluator (§9.3, §9.6). It OWNS the timers/socket/OSC parsing
 * that produce state signals and pushes each freshly-evaluated {@link SessionState}
 * to the subscriber (which routes it through the single-writer `ingestSessionState`
 * command). Push, not poll: the composite already runs its own 200 ms / 1 s cadence
 * internally, so the Application just subscribes once and disposes on session exit.
 */
export interface StateEvaluator {
  /** Register the sink for state changes. Called once by the start-runtime use case. */
  onStateChange(listener: (state: SessionState, meta?: StateChangeMeta) => void): void
  /**
   * Manually re-evaluate now (the "refresh state" affordance, R1/§5.4). Optional:
   * a backend that can't force a re-poll (or hasn't wired it) simply omits it.
   */
  refresh?(): void
  /** Stop all timers/listeners and release the socket. Called on session teardown. */
  dispose(): void
}

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
