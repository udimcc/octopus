/**
 * Persist the live scrollback of every DIRTY session (DESIGN §6.6). Shared by the
 * periodic flush (main's `scrollback-flush-scheduler.ts`), the quit/shutdown
 * flushes and a spontaneous exit, so history no longer waits for a graceful quit:
 * an app killed at reboot loses at most one flush interval.
 *
 * Deliberately NOT a CommandLoop command: scrollback is I13 metadata, not domain
 * state, and the loop is FIFO, so a long `createTask`/`deleteTask` ahead of it would
 * starve the flush exactly when data is at risk. It is one synchronous block (better-
 * sqlite3), so no use case can interleave with it; a close or task delete that already
 * ran has dropped the buffer (and `saveScrollback` no-ops on a missing session row).
 *
 * One transaction per call (one WAL commit). `maxBytes` bounds a periodic tick's
 * main-thread cost: once it is exceeded the rest stay dirty for the next tick, and
 * because dirty entries come longest-dirty first no session starves. Best-effort
 * per session — a failed write leaves that session dirty for a retry; sessions
 * are marked clean only after the commit.
 */

import type { AppDependencies } from './dependencies'
import type { SessionId } from '../domain/ids'

export interface FlushScrollbacksOptions {
  /** Stop after writing this many characters (UTF-16 units). Default: no limit. */
  readonly maxBytes?: number
}

/** Returns how many sessions were written. Never throws. */
export function flushScrollbacks(
  deps: Pick<AppDependencies, 'persistence' | 'scrollbacks'>,
  opts: FlushScrollbacksOptions = {}
): number {
  const maxBytes = opts.maxBytes ?? Infinity
  const saved: SessionId[] = []
  try {
    deps.persistence.transaction(() => {
      let bytes = 0
      for (const [sessionId, data] of deps.scrollbacks.dirtyEntries()) {
        if (bytes >= maxBytes) {
          break
        }
        try {
          deps.persistence.saveScrollback(sessionId, data)
          saved.push(sessionId)
          bytes += data.length
        } catch {
          // Leave it dirty; the next flush retries. Keep flushing the rest.
        }
      }
    })
  } catch {
    // The store is closed or the commit failed (rolled back): everything stays
    // dirty. Scrollback is best-effort; never break the caller (a timer tick, quit,
    // a shutdown signal).
    return 0
  }
  // Only after the commit: a rolled-back write must stay dirty.
  for (const sessionId of saved) {
    deps.scrollbacks.markClean(sessionId)
  }
  return saved.length
}
