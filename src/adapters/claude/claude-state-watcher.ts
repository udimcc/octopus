/**
 * The app-side consumer of the new Claude state source edge (DESIGN §9.6). Watches
 * the `claude-state/` dir the python bridge writes to, and turns each `<id>.json`
 * change into a `(sessionId, SessionState, meta)` push — the SOLE driver of the
 * application's `onSessionState` sink (which dispatches `ingestSessionState` on the
 * single-writer loop). This replaces the per-runtime `StateEvaluator` subscription
 * and the entire socket/composite/OSC pipeline; the domain, command, events, IPC and
 * renderer are untouched.
 *
 * Two triggers, one path:
 *   - INITIAL SCAN on construction — this is the resume-recovery step: after an app
 *     restart the bridge's files already reflect each session's state (a live hook or
 *     a statusline transcript read), so we replay them so restored tabs show status
 *     immediately, without waiting for the next hook.
 *   - fs.watch — each subsequent write. `fs.watch` fires rapidly and repeatedly for a
 *     single logical write (rename+change from the atomic temp+replace), so we
 *     per-file debounce and re-read on settle rather than trusting any single event.
 *
 * The filename stem IS the `OCTOPUS_SESSION_ID`, which the app knows as `session.id`
 * (the bridge is keyed by the same env var Octopus injects into the PTY, so the
 * correlation is exact). Unknown ids (a stale file for a deleted session) still push;
 * `ingestSessionState` no-ops for a session the workspace doesn't hold, so a stray
 * file is harmless.
 */

import { watch, readdirSync, readFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { SessionState } from '../../domain/state'
import type { StateChangeMeta } from '../../ports/session-runtime'
import { coreToSessionState } from './core-to-session-state'

/** Sink for each state change; wired to the app's `onSessionState` in the root. */
export type ClaudeStateSink = (
  sessionId: string,
  state: SessionState,
  meta?: StateChangeMeta
) => void

export interface ClaudeStateWatcherOptions {
  /** The `claude-state/` directory to watch (from `AppPaths.claudeStateDir`). */
  readonly dir: string
  /** Called for each session-state change (initial scan + every subsequent write). */
  readonly sink: ClaudeStateSink
  /** Best-effort error reporter (an unreadable/corrupt file is skipped, not fatal). */
  readonly onError?: (message: string) => void
  /** Debounce window (ms) coalescing an atomic write's rename+change burst. Default 40. */
  readonly debounceMs?: number
  /** Timer injection for tests; defaults to setTimeout/clearTimeout. */
  readonly timers?: {
    setTimer(fn: () => void, ms: number): unknown
    clearTimer(handle: unknown): void
  }
}

export interface ClaudeStateWatcher {
  /** Force a re-read + push for one session (backs the `refresh state` affordance, R1). */
  rescan(sessionId: string): void
  /** Stop watching and clear pending timers. */
  dispose(): void
}

const STATE_SUFFIX = '.json'
const DEFAULT_TIMERS = {
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/**
 * Start watching `dir`. Fires `sink` once per existing file immediately (resume
 * recovery), then on every subsequent change. Never throws on a bad file — reports
 * via `onError` and skips. If the dir can't be watched at all (should not happen —
 * `ensureClaudeStateScript` creates it), the initial scan still runs and `onError`
 * is reported; the watcher becomes inert.
 */
export function createClaudeStateWatcher(opts: ClaudeStateWatcherOptions): ClaudeStateWatcher {
  const timers = opts.timers ?? DEFAULT_TIMERS
  const debounceMs = opts.debounceMs ?? 40
  const pending = new Map<string, unknown>()
  let watcher: FSWatcher | undefined

  const emit = (sessionId: string): void => {
    let raw: string
    try {
      raw = readFileSync(join(opts.dir, sessionId + STATE_SUFFIX), 'utf8')
    } catch {
      return // file vanished between the event and the read — nothing to emit.
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      opts.onError?.(`ignoring malformed claude-state file: ${sessionId}${STATE_SUFFIX}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return
    }
    const record = parsed as { state?: unknown; reason?: unknown }
    const state: SessionState = coreToSessionState(
      typeof record.state === 'string' ? record.state : 'unknown'
    )
    const meta: StateChangeMeta | undefined =
      typeof record.reason === 'string' ? { reason: record.reason } : undefined
    opts.sink(sessionId, state, meta)
  }

  const schedule = (sessionId: string): void => {
    const existing = pending.get(sessionId)
    if (existing !== undefined) {
      timers.clearTimer(existing)
    }
    pending.set(
      sessionId,
      timers.setTimer(() => {
        pending.delete(sessionId)
        emit(sessionId)
      }, debounceMs)
    )
  }

  // Initial scan (resume recovery). Emit synchronously so restored state is queued
  // before the first window hydrates.
  try {
    for (const name of readdirSync(opts.dir)) {
      if (name.endsWith(STATE_SUFFIX)) {
        emit(name.slice(0, -STATE_SUFFIX.length))
      }
    }
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err))
  }

  try {
    watcher = watch(opts.dir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (!name.endsWith(STATE_SUFFIX)) return
      schedule(name.slice(0, -STATE_SUFFIX.length))
    })
    watcher.on('error', (err) => opts.onError?.(err.message))
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err))
  }

  return {
    rescan: (sessionId) => emit(sessionId),
    dispose: () => {
      for (const handle of pending.values()) {
        timers.clearTimer(handle)
      }
      pending.clear()
      watcher?.close()
      watcher = undefined
    }
  }
}
