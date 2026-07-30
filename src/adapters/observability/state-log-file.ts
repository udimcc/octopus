/**
 * File-backed {@link StateLog} (DESIGN §11, R1): appends one JSON object per line
 * (JSONL) to `paths.stateLogPath` — `~/.local/share/octopus/logs/state.log`. Each
 * line is a {@link StateTransition}, so the file is grep-able and streamable for
 * tuning the §9.3 thresholds and feeding offline analysis.
 *
 * BEST-EFFORT by contract (§6.6): every write is wrapped so an I/O failure (full
 * disk, permission, missing dir) can NEVER throw into the single-writer command
 * loop — a lost log line must not derail a state update. We use `appendFileSync`
 * with `flag: 'a'`: the record call is synchronous inside the loop but tiny
 * (one short line), and synchronous append keeps ordering trivially correct
 * without an async queue. The parent `logsDir` is ensured by `ensureAppDirs`
 * (paths.ts) at bootstrap, so no per-write mkdir is needed.
 *
 * A failure is reported at most once via the injected `onError` (composition-root
 * logs a single warning) so a persistently-unwritable log doesn't spam stderr on
 * every transition.
 */

import { appendFileSync } from 'node:fs'
import type { StateLog, StateTransition } from '../../ports/state-log'

export interface StateLogFileOptions {
  /** Absolute path to the JSONL log file (`paths.stateLogPath`). */
  readonly path: string
  /** Injected append (defaults to `node:fs` `appendFileSync`) — swappable in tests. */
  readonly append?: (path: string, data: string) => void
  /** Called at most once, on the first write failure (composition-root warns). */
  readonly onError?: (error: unknown) => void
}

export function createStateLogFile(options: StateLogFileOptions): StateLog {
  const append = options.append ?? ((path, data) => appendFileSync(path, data, 'utf8'))
  let warned = false

  return {
    record(transition: StateTransition): void {
      try {
        append(options.path, JSON.stringify(transition) + '\n')
      } catch (error) {
        // Best-effort: never propagate into the command loop; warn once.
        if (!warned) {
          warned = true
          options.onError?.(error)
        }
      }
    }
  }
}
