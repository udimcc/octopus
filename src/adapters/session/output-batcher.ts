/**
 * Per-session output batcher (DESIGN §6.6). node-pty has no flow control by
 * design — blocking a PTY would stall an interactive agent — so back-pressure is
 * managed on the OUTPUT side: accumulate chunks and flush on a short timer, or
 * immediately once the buffer reaches a 256 KB cap. This coalesces the thousands
 * of tiny writes a busy shell emits into a handful of IPC messages.
 *
 * The default is LEADING-EDGE (§6.6, reconciled with §11's `PTY read→render <5 ms`
 * target): the first chunk arriving on an idle buffer flushes immediately so an
 * interactive keystroke echo (e.g. typing in `vi`) is not held for the interval.
 * A trailing timer is still armed after the lead flush, so any chunks that follow
 * within the window coalesce into a single later flush.
 *
 * Why the interval is SHORT (3 ms), not the "60 Hz" (16 ms) the batcher originally
 * used: an interactive echo is not a single chunk. `vi` brackets each redraw with
 * cursor hide/show (`\x1b[?25l` … glyph … `\x1b[?25h`), which node-pty delivers as
 * several back-to-back `onData` chunks. Leading-edge flushes the first (the
 * invisible cursor-hide) instantly, but the VISIBLE glyph rides a later chunk and
 * waits out the trailing window — so a long window is felt as input lag. xterm
 * ALREADY coalesces painting to ~60 Hz via requestAnimationFrame, so this timer is
 * not needed to bound the render rate; its only job is bounding IPC message COUNT,
 * and under a genuine flood the 256 KB cap dominates (flushes become byte-driven,
 * not timer-driven). A 3 ms window is therefore imperceptible for typing yet still
 * coalesces simultaneous chunk bursts, with no IPC-storm risk. Pass
 * `leadingEdge: false` for pure trailing-edge batching (used by tests that assert
 * coalescing without the lead emit).
 *
 * Pure and timer-injectable so the timing is deterministic in tests: the default
 * timers are the globals, but tests pass a fake scheduler. Byte accounting uses
 * UTF-8 length (the cap is a burst safety-valve; approximate is fine).
 */

/** Injectable timer surface (defaults to the globals). */
export interface BatcherTimers {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

const DEFAULT_TIMERS: BatcherTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export interface OutputBatcherOptions {
  /**
   * Trailing-window length in ms (default 3). Kept short because xterm already
   * paces painting via rAF; this only coalesces near-simultaneous chunk bursts so
   * a `vi` redraw's visible glyph is not held behind its cursor-hide prefix (§6.6).
   */
  readonly intervalMs?: number
  /** Immediate-flush byte cap (default 256 KiB, §6.6). */
  readonly maxBytes?: number
  /**
   * Flush the first chunk on an idle buffer immediately, then arm the trailing
   * timer for follow-ups (default `true`, §6.6/§11). Set `false` for pure
   * trailing-edge batching.
   */
  readonly leadingEdge?: boolean
  readonly timers?: BatcherTimers
}

export class OutputBatcher {
  private readonly onFlush: (data: string) => void
  private readonly intervalMs: number
  private readonly maxBytes: number
  private readonly leadingEdge: boolean
  private readonly timers: BatcherTimers

  private pending: string[] = []
  private pendingBytes = 0
  private timer: unknown = null

  constructor(onFlush: (data: string) => void, opts: OutputBatcherOptions = {}) {
    this.onFlush = onFlush
    this.intervalMs = opts.intervalMs ?? 3
    this.maxBytes = opts.maxBytes ?? 256 * 1024
    this.leadingEdge = opts.leadingEdge ?? true
    this.timers = opts.timers ?? DEFAULT_TIMERS
  }

  /**
   * Queue a chunk. Schedules a timer flush if none is pending; flushes
   * immediately if the queued bytes reach the cap (so a huge burst never sits in
   * memory for a whole interval).
   */
  push(data: string): void {
    if (data.length === 0) {
      return
    }
    this.pending.push(data)
    this.pendingBytes += Buffer.byteLength(data, 'utf8')
    if (this.pendingBytes >= this.maxBytes) {
      this.flush()
      return
    }
    if (this.timer !== null) {
      // A window is already open: this chunk coalesces into the pending flush.
      return
    }
    if (this.leadingEdge) {
      // Idle buffer + leading-edge: emit now for instant echo (§11 <5 ms), then
      // open a trailing window so follow-up chunks coalesce. If nothing follows,
      // the armed timer fires once on an empty buffer — a no-op in flush().
      this.flush()
      this.timer = this.timers.setTimer(() => this.flush(), this.intervalMs)
      return
    }
    this.timer = this.timers.setTimer(() => this.flush(), this.intervalMs)
  }

  /** Emit everything queued now and cancel any pending timer. No-op if empty. */
  flush(): void {
    if (this.timer !== null) {
      this.timers.clearTimer(this.timer)
      this.timer = null
    }
    if (this.pending.length === 0) {
      return
    }
    const data = this.pending.join('')
    this.pending = []
    this.pendingBytes = 0
    this.onFlush(data)
  }

  /** Cancel the timer and DROP pending data without flushing (used on dispose). */
  dispose(): void {
    if (this.timer !== null) {
      this.timers.clearTimer(this.timer)
      this.timer = null
    }
    this.pending = []
    this.pendingBytes = 0
  }
}
