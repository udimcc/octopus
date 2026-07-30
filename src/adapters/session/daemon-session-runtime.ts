/**
 * `SessionRuntime` backed by the `octopusd` daemon (DESIGN §6.2) — the durable
 * counterpart to `PtyTerminalRuntime`. It proxies the runtime contract over the
 * shared {@link DaemonClient} connection: `start` → `spawn` OR `attach`, `write`/
 * `resize` → the same, `stop` → `close`, `dispose` → `detach` (NOT close).
 *
 * ## start = spawn vs attach (the whole point)
 * If `ctx.resume` is set (the composition root found this session id in the
 * daemon's live roster), `start()` RE-ATTACHES: the daemon replays its server-side
 * ring buffer, so the terminal repaints with the pre-restart scrollback and the
 * still-running program (vim/Claude) is right there. Otherwise it SPAWNS a fresh
 * PTY. Either way the session walks `Created → Starting → Running` identically, so
 * no state-machine or mapper change is needed (§10 additive).
 *
 * ## Exit discrimination (mirrors PtyTerminalRuntime)
 * The daemon reproduces the `stopping`-flag split, but the discrimination the
 * command loop cares about is re-derived HERE too: a `stop()` sets `stopping` and
 * resolves on the daemon's `closed` reply, SUPPRESSING `ctx.onExit`; a spontaneous
 * `exit` frame (stopping off) routes to `ctx.onExit` → `handleRuntimeExit`. This
 * keeps the illegal `Closed → Exited` race closed on the daemon path too (§3.6).
 *
 * ## No local batching
 * The daemon batches output BEFORE the socket hop (§6.2), so `data` frames arrive
 * already coalesced — the runtime forwards each straight to `ctx.onData`, unlike
 * the in-process runtime which owns the batcher itself.
 *
 * Batch replay note: the daemon writes the replayed buffer as a `data` frame the
 * instant `attach` runs, BEFORE the `attached` reply. The manager registers this
 * runtime's sink before calling `start()`, so that first chunk is never dropped.
 */

import type {
  SessionRuntime,
  SessionRuntimeContext,
  StateEvaluator,
  StateChangeMeta
} from '../../ports/session-runtime'
import type { SessionState } from '../../domain/state'
import type { SpawnParams } from '../../shared/node/daemon-protocol'
import type { DaemonClient, DaemonSessionSink, DaemonStateUpdate } from './daemon-client'
import { coreToSessionState } from './composite-state-evaluator'

/**
 * Bridges the daemon's unsolicited `state` frames (§9.6) into the ports
 * {@link StateEvaluator} the Application subscribes to. The daemon runs the actual
 * {@link CompositeStateProvider}; this side just maps each {@link DaemonStateUpdate}
 * (plain `CoreState` string + metadata) to the domain {@link SessionState} and
 * forwards it — the mirror of {@link CompositeStateEvaluator}, whose composite is
 * local. `refresh()` asks the daemon to re-emit.
 */
class DaemonStateEvaluator implements StateEvaluator {
  private listener: ((state: SessionState, meta?: StateChangeMeta) => void) | null = null
  /**
   * The most recent update seen BEFORE a listener subscribed. On a re-attach the
   * daemon replays its last state inside `start()` — which runs before
   * `startSessionRuntime` subscribes — so buffer it and flush on subscribe, else a
   * resumed session's initial (possibly stable) state would never reach the loop.
   */
  private buffered: DaemonStateUpdate | null = null

  constructor(
    private readonly client: DaemonClient,
    private readonly sessionId: string
  ) {}

  onStateChange(listener: (state: SessionState, meta?: StateChangeMeta) => void): void {
    this.listener = listener
    if (this.buffered) {
      const update = this.buffered
      this.buffered = null
      this.emit(update)
    }
  }

  /** Called from the session sink for each daemon `state` frame. */
  push(update: DaemonStateUpdate): void {
    if (!this.listener) {
      this.buffered = update
      return
    }
    this.emit(update)
  }

  private emit(update: DaemonStateUpdate): void {
    this.listener?.(coreToSessionState(update.state), {
      layer: update.layer,
      confidence: update.confidence,
      reason: update.reason
    })
  }

  refresh(): void {
    this.client.refreshState(this.sessionId)
  }

  dispose(): void {
    this.listener = null
  }
}

export interface DaemonSessionRuntimeOptions {
  readonly client: DaemonClient
  /** Fully-resolved shell (the manager runs `resolveShell`, which needs settings). */
  readonly shell: string
  /** Login-shell args (`-l`) by default, or the OSC 133 integration args (§6.1, §12.1). */
  readonly args?: readonly string[]
  /**
   * Extra env for the child (§12.1) — e.g. `ZDOTDIR`/`OCTOPUS_USER_BASHRC` for shell
   * integration — forwarded to the daemon in `spawn` and layered onto its child env.
   */
  readonly envPatch?: Readonly<Record<string, string>>
  /**
   * Whether to surface a {@link StateEvaluator} (§9). The daemon ALWAYS runs its
   * composite and pushes `state` frames (cheap, unconditional — see daemon/index.ts),
   * so the per-user opt-out is enforced HERE: when `false`, `stateEvaluator()`
   * returns null, `startSessionRuntime` never subscribes, and the pushed frames are
   * simply dropped by the (still-registered) sink into a detached evaluator. Mirrors
   * the in-process gate in `PtySessionManager` (no registry → no evaluator).
   */
  readonly stateDetection?: boolean
}

const DEFAULT_ARGS = ['-l'] as const

export class DaemonSessionRuntime implements SessionRuntime {
  private readonly ctx: SessionRuntimeContext
  private readonly client: DaemonClient
  private readonly shell: string
  private readonly args: readonly string[]
  private readonly envPatch?: Readonly<Record<string, string>>
  private readonly sessionId: string
  private readonly stateDetection: boolean

  private started = false
  private exited = false
  private stopping = false
  private readonly evaluator: DaemonStateEvaluator

  constructor(ctx: SessionRuntimeContext, opts: DaemonSessionRuntimeOptions) {
    this.ctx = ctx
    this.client = opts.client
    this.shell = opts.shell
    this.args = opts.args ?? DEFAULT_ARGS
    this.envPatch = opts.envPatch
    this.sessionId = ctx.sessionId
    this.stateDetection = opts.stateDetection ?? true
    this.evaluator = new DaemonStateEvaluator(this.client, this.sessionId)
  }

  /**
   * Attach to a live daemon session (when `ctx.resume`) or spawn a fresh one.
   * Rejects → the session goes `StartFailed` (§3.6), same as the in-process path.
   */
  async start(): Promise<void> {
    // Register the sink FIRST: on attach the daemon replays its buffer as a `data`
    // frame before the reply resolves, and we must not drop it.
    this.client.registerSink(this.sessionId, this.makeSink())
    try {
      await this.client.ensureReady()
      if (this.ctx.resume) {
        await this.client.attach(this.sessionId)
      } else {
        await this.client.spawn(this.spawnParams())
      }
    } catch (err) {
      this.client.unregisterSink(this.sessionId)
      throw err instanceof Error ? err : new Error(String(err))
    }
    this.started = true
  }

  write(data: string): void {
    if (!this.exited) {
      this.client.write(this.sessionId, data)
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) {
      this.client.resize(this.sessionId, cols, rows)
    }
  }

  /**
   * Graceful close: `close` runs SIGHUP→grace→SIGKILL daemon-side and replies
   * `closed`. Sets `stopping` so the daemon's resulting death is NOT surfaced as a
   * spontaneous `ctx.onExit` (the caller drives `Stopping → Closed`, §3.6).
   */
  async stop(): Promise<void> {
    if (this.exited || !this.started) {
      return
    }
    this.stopping = true
    try {
      await this.client.close(this.sessionId)
    } finally {
      this.exited = true
      this.client.unregisterSink(this.sessionId)
    }
  }

  /**
   * Release the local handle WITHOUT killing the PTY: `detach` tells the daemon to
   * stop streaming while the process keeps running (§6.2 — durability). Used after
   * an observed exit or when tearing down a view. This is the crucial difference
   * from the in-process runtime, whose `dispose` SIGKILLs a still-live child.
   */
  dispose(): void {
    this.client.unregisterSink(this.sessionId)
    if (!this.exited) {
      this.client.detach(this.sessionId)
    }
  }

  /**
   * The daemon-fed state evaluator (§9.6): the daemon runs the composite and pushes
   * `state` frames, which the sink routes into this evaluator. Returns null when the
   * user opted out (`terminal.stateDetection === false`) so `startSessionRuntime`
   * never subscribes — the mirror of the in-process gate (§9). The daemon still pushes
   * frames (cheap); the sink drops them into an unsubscribed evaluator.
   */
  stateEvaluator(): StateEvaluator | null {
    return this.stateDetection ? this.evaluator : null
  }

  /**
   * Where the shell has `cd`'d to (§6.2). The daemon resolves each live PTY's cwd
   * from `/proc/<pid>/cwd` for its roster, so we read it off `listSessions` rather
   * than holding a pid locally. `undefined` once exited or if the roster lacks it.
   */
  async currentCwd(): Promise<string | undefined> {
    if (this.exited) {
      return undefined
    }
    const sessions = await this.client.listSessions()
    return sessions.find((s) => s.sessionId === this.sessionId)?.cwd
  }

  private makeSink(): DaemonSessionSink {
    return {
      onData: (data) => {
        if (!this.exited) {
          this.ctx.onData(data)
        }
      },
      onExit: (exitCode, signal) => {
        if (this.exited) {
          return
        }
        this.exited = true
        // A user `stop()` owns its own resolution; only a SPONTANEOUS death (or a
        // daemon-crash synthetic exit) drives markExited (§3.6).
        if (!this.stopping) {
          this.ctx.onExit(exitCode, signal)
        }
      },
      onState: (update) => this.evaluator.push(update)
    }
  }

  private spawnParams(): SpawnParams {
    return {
      sessionId: this.sessionId,
      taskId: this.ctx.taskId,
      shell: this.shell,
      args: this.args,
      cwd: this.ctx.worktreePath,
      cols: this.ctx.cols,
      rows: this.ctx.rows,
      stateSocketPath: this.ctx.stateSocketPath,
      envPatch: this.envPatch
    }
  }
}
