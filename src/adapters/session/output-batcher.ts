/**
 * Per-session output batcher (DESIGN §6.6). node-pty has no flow control by
 * design — blocking a PTY would stall an interactive agent — so back-pressure is
 * managed on the OUTPUT side: accumulate chunks and flush on a 16 ms (~60 Hz)
 * timer, or immediately once the buffer reaches a 256 KB cap. This coalesces the
 * thousands of tiny writes a busy shell emits into a handful of IPC messages.
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
  /** Flush interval in ms (default 16 ≈ 60 Hz, §6.6). */
  readonly intervalMs?: number
  /** Immediate-flush byte cap (default 256 KiB, §6.6). */
  readonly maxBytes?: number
  readonly timers?: BatcherTimers
}

export class OutputBatcher {
  private readonly onFlush: (data: string) => void
  private readonly intervalMs: number
  private readonly maxBytes: number
  private readonly timers: BatcherTimers

  private pending: string[] = []
  private pendingBytes = 0
  private timer: unknown = null

  constructor(onFlush: (data: string) => void, opts: OutputBatcherOptions = {}) {
    this.onFlush = onFlush
    this.intervalMs = opts.intervalMs ?? 16
    this.maxBytes = opts.maxBytes ?? 256 * 1024
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
    if (this.timer === null) {
      this.timer = this.timers.setTimer(() => this.flush(), this.intervalMs)
    }
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
