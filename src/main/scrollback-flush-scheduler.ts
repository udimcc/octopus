/**
 * Periodic scrollback flush (DESIGN §6.6). Before this, terminal output reached the
 * DB only on a graceful quit or a shell exit, so an app killed at reboot (or by a
 * crash, OOM, SIGKILL) lost every session's output since its last launch. Every
 * `intervalMs` this runs the injected `flush` (`flushScrollbacks` with a per-tick
 * byte budget), which writes only the sessions that produced output since their
 * last flush, so idle sessions cost nothing.
 *
 * Timers are injected so it is testable with fake timers; it never imports Electron.
 * The timer is `unref`ed so it never keeps the process alive.
 */

/** Flush cadence: the most output an app kill can lose. */
export const SCROLLBACK_FLUSH_INTERVAL_MS = 30_000
/**
 * Per-tick write budget (characters). Bounds one tick's synchronous main-thread work
 * (~1.5 ms per 512 KB session) to a few tens of ms; the rest waits for the next tick.
 */
export const SCROLLBACK_FLUSH_TICK_BYTES = 4 * 1024 * 1024

export interface ScrollbackFlushSchedulerDeps {
  readonly flush: () => void
  readonly intervalMs?: number
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface ScrollbackFlushScheduler {
  /** Start ticking. Idempotent. */
  start(): void
  /** Stop ticking. Idempotent; called before the store closes. */
  stop(): void
}

export function createScrollbackFlushScheduler(
  deps: ScrollbackFlushSchedulerDeps
): ScrollbackFlushScheduler {
  const intervalMs = deps.intervalMs ?? SCROLLBACK_FLUSH_INTERVAL_MS
  const setTimer =
    deps.setInterval ??
    ((fn: () => void, ms: number): unknown => {
      const h = setInterval(fn, ms)
      h.unref()
      return h
    })
  const clearTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout))
  let timer: unknown

  return {
    start() {
      if (timer === undefined) {
        timer = setTimer(() => {
          try {
            deps.flush()
          } catch {
            // flushScrollbacks never throws; guard the timer regardless.
          }
        }, intervalMs)
      }
    },
    stop() {
      if (timer !== undefined) {
        clearTimer(timer)
        timer = undefined
      }
    }
  }
}
