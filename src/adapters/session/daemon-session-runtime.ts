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
 *
 * ## Re-attach repaint (see {@link REDRAW_NUDGE_MS})
 * Replaying the ring buffer restores what the OLD terminal showed; it does not make
 * the still-running program paint into the NEW one. A full-screen program (emacs,
 * vim, Claude) only emits when it has a reason to, so a re-attached pane stays blank
 * or stale until the user types. `resize()` after a resume forces that reason.
 */

import type { SessionRuntime, SessionRuntimeContext } from '../../ports/session-runtime'
import type { SpawnParams } from '../../shared/node/daemon-protocol'
import type { DaemonClient, DaemonSessionSink } from './daemon-client'

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
  /** Test seam for the re-attach redraw nudge (default `setTimeout`). */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
}

const DEFAULT_ARGS = ['-l'] as const

/**
 * Gap between the two halves of the re-attach redraw nudge.
 *
 * A program that has been running since before the app restarted has already painted
 * its screen into a terminal that no longer exists, and nothing in the protocol asks it
 * to paint again. The one repaint trigger available without injecting keystrokes is
 * SIGWINCH — but the kernel short-circuits `TIOCSWINSZ` when the new winsize EQUALS the
 * old one (`tty_do_resize`: no change, NO signal), and after a restore the daemon's PTY
 * usually already has the size the new pane fits to. So the first resize after a resume
 * is sent as a pair: one row shorter, then the true size.
 *
 * The two must be separated in TIME, not just in sequence: standard signals do not
 * queue, so back-to-back ioctls can collapse into a single SIGWINCH whose handler reads
 * the final (unchanged) size and concludes there is nothing to do — the exact no-op we
 * are trying to avoid. One frame of delay is enough for the child to be scheduled, run
 * its handler and repaint at the intermediate size before the second ioctl corrects it.
 */
export const REDRAW_NUDGE_MS = 50

export class DaemonSessionRuntime implements SessionRuntime {
  private readonly ctx: SessionRuntimeContext
  private readonly client: DaemonClient
  private readonly shell: string
  private readonly args: readonly string[]
  private readonly envPatch?: Readonly<Record<string, string>>
  private readonly sessionId: string
  private readonly setTimer: (fn: () => void, ms: number) => unknown

  private started = false
  private exited = false
  private stopping = false
  /** Set on a resumed `start()`; consumed by the first `resize()` (see REDRAW_NUDGE_MS). */
  private redrawPending = false
  /** Monotonic resize counter, so a deferred nudge can tell it has been superseded. */
  private resizeSeq = 0

  constructor(ctx: SessionRuntimeContext, opts: DaemonSessionRuntimeOptions) {
    this.ctx = ctx
    this.client = opts.client
    this.shell = opts.shell
    this.args = opts.args ?? DEFAULT_ARGS
    this.envPatch = opts.envPatch
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.sessionId = ctx.sessionId
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
        this.redrawPending = true
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
    if (this.exited) {
      return
    }
    if (this.redrawPending) {
      // First resize after a re-attach: bracket it so the still-running program is
      // guaranteed a real SIGWINCH and repaints into the new terminal (REDRAW_NUDGE_MS).
      // This fires exactly when a pane gets a layout box — i.e. when the user actually
      // looks at the session, since a hidden task's panes don't resize at all.
      this.redrawPending = false
      const seq = ++this.resizeSeq
      const nudged = rows > 1 ? rows - 1 : rows + 1
      this.client.resize(this.sessionId, cols, nudged)
      this.setTimer(() => {
        // A resize that landed in the meantime (the user dragging the window) already
        // set the true size — and differs from `nudged`, so it signalled too. Don't
        // undo it with a stale one.
        if (!this.exited && this.resizeSeq === seq) {
          this.client.resize(this.sessionId, cols, rows)
        }
      }, REDRAW_NUDGE_MS)
      return
    }
    this.resizeSeq++
    this.client.resize(this.sessionId, cols, rows)
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
   * Where the shell has `cd`'d to (§6.2). The daemon resolves each live PTY's cwd
   * (`/proc/<pid>/cwd` on Linux, batched `lsof` on macOS) for its roster, so we
   * read it off `listSessions` rather than holding a pid locally. `undefined` once
   * exited or if the roster lacks it.
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
      }
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
      envPatch: this.envPatch
    }
  }
}
