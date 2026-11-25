/**
 * `SessionRuntime` for a terminal session, backed by one PTY (DESIGN §6.1, §6.6).
 * The actual node-pty binding lives in `pty-session-manager.ts`; THIS file takes
 * an injected `spawn` (a narrow {@link PtySpawn}) so the runtime's logic —
 * output batching, exit routing, the SIGHUP→grace→SIGKILL close — is fully
 * unit-testable with a fake PTY and no native module.
 *
 * Exit semantics (the subtle part, §3.6/§6.1):
 *   - A SPONTANEOUS process death → `ctx.onExit` fires → the command loop marks
 *     the session `Exited` and emits `sessionExited`.
 *   - A USER close goes through `stop()`, which sets a `stopping` flag that
 *     SUPPRESSES `ctx.onExit`; `close-session` then drives `Stopping → Closed`
 *     itself. This avoids the illegal `Closed → Exited` race when our own SIGHUP
 *     is what killed the process.
 */

import type { SessionRuntime, SessionRuntimeContext } from '../../ports/session-runtime'
import {
  OutputBatcher,
  type BatcherTimers,
  type OutputBatcherOptions
} from '../../shared/node/output-batcher'
import { buildPtyEnv } from '../../shared/pty-env'
import { procCwdAsync } from '../../shared/node/proc-cwd'
import type { OsProfile } from '../../shared/os'

/** A disposable listener registration (node-pty's IDisposable shape). */
export interface PtyDisposable {
  dispose(): void
}

/** The narrow slice of node-pty's `IPty` this runtime uses. */
export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): PtyDisposable
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): PtyDisposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtySpawnOptions {
  readonly name: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: Record<string, string>
}

/** Narrow spawn signature; node-pty's `spawn` is assignable to it. */
export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess

export interface PtyTerminalRuntimeOptions {
  readonly spawn: PtySpawn
  /** Host OS profile: PTY env defaults and how the shell's cwd is read. */
  readonly os: OsProfile
  /** Fully-resolved shell to launch (§6.1); the manager resolves the fallbacks. */
  readonly shell: string
  /**
   * Shell argv (§6.1, §12.1). Defaults to a login shell (`-l`); the manager passes
   * OSC 133 integration args (`--rcfile … -i` for bash, `-i` for zsh) when shell
   * integration is injected.
   */
  readonly args?: readonly string[]
  /**
   * Extra env layered onto {@link buildPtyEnv}'s output (§12.1) — e.g. `ZDOTDIR` /
   * `OCTOPUS_USER_BASHRC` for shell integration. Applied last so it wins.
   */
  readonly envPatch?: Readonly<Record<string, string>>
  /**
   * Control-socket path exported to every session as `OCTOPUS_CONTROL_SOCKET` so
   * `octopus-cli` inside a terminal finds this instance (control socket design).
   */
  readonly controlSocketPath?: string
  /** Grace period between SIGHUP and SIGKILL on close (default 2000 ms, §6.1). */
  readonly graceMs?: number
  readonly timers?: BatcherTimers
  readonly batcher?: OutputBatcherOptions
}

const DEFAULT_TIMERS: BatcherTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class PtyTerminalRuntime implements SessionRuntime {
  private readonly ctx: SessionRuntimeContext
  private readonly spawn: PtySpawn
  private readonly shell: string
  private readonly args: readonly string[]
  private readonly envPatch: Readonly<Record<string, string>>
  private readonly controlSocketPath?: string
  private readonly graceMs: number
  private readonly os: OsProfile
  private readonly timers: BatcherTimers
  private readonly batcher: OutputBatcher

  private pty?: PtyProcess
  private dataSub?: PtyDisposable
  private exitSub?: PtyDisposable
  private exited = false
  private stopping = false
  private stopResolvers: Array<() => void> = []

  constructor(ctx: SessionRuntimeContext, opts: PtyTerminalRuntimeOptions) {
    this.ctx = ctx
    this.spawn = opts.spawn
    this.shell = opts.shell
    this.args = opts.args ?? ['-l']
    this.envPatch = opts.envPatch ?? {}
    this.controlSocketPath = opts.controlSocketPath
    this.os = opts.os
    this.graceMs = opts.graceMs ?? 2000
    this.timers = opts.timers ?? DEFAULT_TIMERS
    this.batcher = new OutputBatcher((data) => this.ctx.onData(data), {
      ...opts.batcher,
      timers: this.timers
    })
  }

  /**
   * Spawn the shell with the configured argv (a login shell `-l` by default, or the
   * OSC 133 integration args, §6.1/§12.1) so profiles load. Synchronous spawn wrapped
   * in a promise: a throw rejects → the session goes `StartFailed`.
   */
  start(): Promise<void> {
    try {
      const env = {
        ...buildPtyEnv(this.ctx.env, {
          taskId: this.ctx.taskId,
          sessionId: this.ctx.sessionId,
          worktreePath: this.ctx.worktreePath,
          controlSocketPath: this.controlSocketPath,
          os: this.os
        }),
        ...this.envPatch
      }
      this.pty = this.spawn(this.shell, [...this.args], {
        name: 'xterm-256color',
        cols: this.ctx.cols,
        rows: this.ctx.rows,
        cwd: this.ctx.worktreePath,
        env
      })
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    this.dataSub = this.pty.onData((data) => this.batcher.push(data))
    this.exitSub = this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal))
    return Promise.resolve()
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.pty) {
      return
    }
    // node-pty throws if the process already died; a resize race is harmless.
    try {
      this.pty.resize(cols, rows)
    } catch {
      // ignore — the process is gone; onExit will (or has) fired.
    }
  }

  /**
   * Graceful close (§6.1): SIGHUP, then SIGKILL after the grace period. Suppresses
   * the spontaneous-exit callback (the caller drives `Closed`). Resolves once the
   * process is confirmed dead or the grace SIGKILL has been sent.
   */
  stop(): Promise<void> {
    if (this.exited || !this.pty) {
      return Promise.resolve()
    }
    this.stopping = true
    return new Promise<void>((resolve) => {
      this.stopResolvers.push(resolve)
      try {
        this.pty?.kill('SIGHUP')
      } catch {
        // Already dead or unkillable — treat as stopped.
        this.settleStop()
        return
      }
      const timer = this.timers.setTimer(() => {
        try {
          this.pty?.kill('SIGKILL')
        } catch {
          // ignore
        }
        this.settleStop()
      }, this.graceMs)
      // If the process exits before the grace elapses, cancel the SIGKILL timer.
      this.stopResolvers.push(() => this.timers.clearTimer(timer))
    })
  }

  /** Release listeners + batcher without signalling; used after an observed exit. */
  dispose(): void {
    this.dataSub?.dispose()
    this.exitSub?.dispose()
    this.dataSub = undefined
    this.exitSub = undefined
    this.batcher.dispose()
    // Safety net: if disposed while still alive, don't leak the child.
    if (!this.exited && this.pty) {
      try {
        this.pty.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    this.pty = undefined
  }

  /**
   * Where the shell has `cd`'d to (§6.2): `/proc/<pid>/cwd` on Linux, an async
   * `lsof` on macOS (`proc-cwd.ts`). `undefined` once the process is gone (or never
   * spawned) — the pid's /proc entry (or lsof record) disappears.
   */
  currentCwd(): Promise<string | undefined> {
    const pid = this.pty?.pid
    if (pid === undefined || this.exited) {
      return Promise.resolve(undefined)
    }
    return procCwdAsync(pid, this.os.proc.cwdProbe)
  }

  private handleExit(exitCode: number, signal?: number): void {
    if (this.exited) {
      return
    }
    this.exited = true
    // Flush any buffered final output so the user can read it (§6.1).
    this.batcher.flush()
    this.dataSub?.dispose()
    this.exitSub?.dispose()
    this.settleStop()
    // Only a SPONTANEOUS exit drives markExited; a user close (stop()) is handled
    // by close-session, which owns the Stopping → Closed transition (§3.6).
    if (!this.stopping) {
      this.ctx.onExit(exitCode, signal)
    }
  }

  private settleStop(): void {
    const resolvers = this.stopResolvers
    this.stopResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }
}
