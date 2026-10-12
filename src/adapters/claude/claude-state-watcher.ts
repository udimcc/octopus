/**
 * The app-side consumer of the Claude state source edge (DESIGN §9.3). The python
 * hook recorder appends one line per Claude hook to `<sessionId>.events.jsonl` in the
 * `claude-state/` dir; this watcher tails those logs, folds them with the pure
 * {@link applyHook} reducer (plus a few facts tailed from the Claude transcript, see
 * `claude-transcript.ts`), and pushes each RESOLVED state change as
 * `(sessionId, SessionState, meta)` — the SOLE driver of the application's
 * `onSessionState` sink (which dispatches `ingestSessionState` on the single-writer
 * loop).
 *
 * ## Which sessions are folded
 * Only TRACKED ones. The runtime-start seam tells the watcher how a session's terminal
 * came to be (`prepareClaudeState` in the composition root):
 *   - {@link ClaudeStateWatcher.reset} — a FRESH PTY: whatever the log says belongs to
 *     a Claude that is gone, so the log is deleted and the session starts Unknown;
 *   - {@link ClaudeStateWatcher.attach} — a daemon RE-ATTACH (the PTY, and the Claude
 *     in it, survived the app restart): the whole log is replayed, so the session shows
 *     its real state at once, including subagents still running.
 * A log for an untracked id is ignored (it is pruned at the next startup).
 *
 * ## Reading
 * One `fs.watch` on the dir, per-file debounced; each settle reads the log from the
 * last offset (a whole-line remainder carries over; an inode change or a shrink means
 * the file was replaced → re-fold from scratch). The transcript is tailed only while
 * the fold says a lead turn is open ({@link transcriptToTail}) — that is the only time
 * an interrupt / denied permission (which fire no hook) can matter. A time-based
 * transition (a background agent whose result never gets picked up) re-resolves on a
 * timer from {@link nextDeadline}. A sink call happens only when the resolved state
 * changes.
 *
 * ## Size
 * At rest (nothing running or pending) a log over `maxEventsBytes` is rotated to
 * `<id>.events.1.jsonl` — a rest point is a clean replay boundary, so `.1` + the
 * current file always re-fold to the right state.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import { SessionState } from '../../domain/state'
import type { StateChangeMeta } from '../../ports/session-runtime'
import {
  applyHook,
  applyTranscript,
  expireWakes,
  initialFold,
  nextDeadline,
  parseHookLine,
  resolveFold,
  transcriptToTail,
  type ClaudeFold
} from './claude-session-fold'
import { parseTranscriptLine } from './claude-transcript'
import { EVENTS_FILE_SUFFIX, ORIGINAL_STATUSLINE_FILE } from './octopus-claude-state.script'

/** Sink for each state change; wired to the app's `onSessionState` in the root. */
export type ClaudeStateSink = (
  sessionId: string,
  state: SessionState,
  meta?: StateChangeMeta
) => void

/** A file-change subscription (`fs.watch` by default). */
export type WatchFn = (path: string, onChange: (filename?: string) => void) => { close(): void }

export interface ClaudeStateWatcherOptions {
  /** The `claude-state/` directory (from `AppPaths.claudeStateDir`). */
  readonly dir: string
  /** Called for each resolved session-state change. */
  readonly sink: ClaudeStateSink
  /** Best-effort error reporter (an unreadable file is skipped, not fatal). */
  readonly onError?: (message: string) => void
  /** Debounce window (ms) coalescing a burst of appends. Default 40. */
  readonly debounceMs?: number
  /** Timer injection for tests; defaults to setTimeout/clearTimeout. */
  readonly timers?: {
    setTimer(fn: () => void, ms: number): unknown
    clearTimer(handle: unknown): void
  }
  /** Clock (epoch ms) for time-based transitions. Default `Date.now`. */
  readonly now?: () => number
  /** File-watch injection for tests. Default wraps `fs.watch`. */
  readonly watch?: WatchFn
  /** How much of a transcript's end is read when tailing starts. Default 256 KiB. */
  readonly transcriptTailBytes?: number
  /** Rotation threshold for an events log. Default 2 MiB. */
  readonly maxEventsBytes?: number
}

export interface ClaudeStateWatcher {
  /** Track a session whose Claude may still be running (re-attach): replay its log. */
  attach(sessionId: string): void
  /** Track a session on a FRESH terminal: drop its log; it starts Unknown. */
  reset(sessionId: string): void
  /** Re-read one session NOW and re-emit its state (the `refresh state` affordance). */
  rescan(sessionId: string): void
  /** Stop watching and clear pending timers. */
  dispose(): void
}

const ROTATED_SUFFIX = '.events.1.jsonl'
const MAX_REMAINDER = 1024 * 1024
const ROTATE_LATE_TAIL_MS = 2_000
const DEFAULT_TIMERS = {
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** Read position in one append-only file. */
interface Cursor {
  ino?: number
  offset: number
  remainder: string
}

interface TranscriptTail extends Cursor {
  path: string
  watcher?: { close(): void }
}

interface Tracked {
  fold: ClaudeFold
  events: Cursor
  transcript?: TranscriptTail
  emitted: SessionState
  debounce?: unknown
  deadline?: unknown
}

const freshCursor = (): Cursor => ({ offset: 0, remainder: '' })

function defaultWatch(onError?: (message: string) => void): WatchFn {
  return (path, onChange) => {
    const w: FSWatcher = watch(path, (_event, filename) => onChange(filename?.toString()))
    w.on('error', (err) => onError?.(err.message))
    return w
  }
}

/**
 * Read whatever was appended to `path` since `cur`, as whole lines. A replaced file
 * (new inode) or a shrunk one restarts from 0 and reports `replaced`. A missing file
 * reads as empty. `minStart` bounds how far back the read reaches (transcript tail:
 * only its last bytes matter); a skipped-to offset drops its first, partial, line.
 */
function readNewLines(
  path: string,
  cur: Cursor,
  minStart?: (size: number) => number
): { lines: string[]; replaced: boolean } {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    const replaced = cur.ino !== undefined
    Object.assign(cur, freshCursor(), { ino: undefined })
    return { lines: [], replaced }
  }
  try {
    const { ino, size } = fstatSync(fd)
    let replaced = false
    if (cur.ino !== undefined && (cur.ino !== ino || size < cur.offset)) {
      Object.assign(cur, freshCursor())
      replaced = true
    }
    cur.ino = ino
    let skipFirst = false
    const start = minStart?.(size) ?? 0
    if (start > cur.offset) {
      cur.offset = start
      cur.remainder = ''
      skipFirst = true
    }
    if (size <= cur.offset) return { lines: [], replaced }
    const buf = Buffer.alloc(size - cur.offset)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, cur.offset + got)
      if (n === 0) break
      got += n
    }
    cur.offset += got
    const text = cur.remainder + buf.subarray(0, got).toString('utf8')
    const parts = text.split('\n')
    const tail = parts.pop() ?? ''
    cur.remainder = tail.length > MAX_REMAINDER ? '' : tail
    if (skipFirst) parts.shift()
    return { lines: parts.filter((l) => l.length > 0), replaced }
  } finally {
    closeSync(fd)
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // absent already
  }
}

/** True when nothing is running, pending or waiting — a clean replay boundary. */
function atRest(f: ClaudeFold): boolean {
  return (
    f.phase !== 'working' &&
    Object.keys(f.roster).length === 0 &&
    Object.keys(f.pendingWake).length === 0 &&
    f.waits.length === 0
  )
}

export function createClaudeStateWatcher(opts: ClaudeStateWatcherOptions): ClaudeStateWatcher {
  const timers = opts.timers ?? DEFAULT_TIMERS
  const now = opts.now ?? Date.now
  const debounceMs = opts.debounceMs ?? 40
  const tailBytes = opts.transcriptTailBytes ?? 256 * 1024
  const maxEventsBytes = opts.maxEventsBytes ?? 2 * 1024 * 1024
  const watchFn = opts.watch ?? defaultWatch(opts.onError)
  const tracked = new Map<string, Tracked>()
  let disposed = false

  const eventsPath = (id: string): string => join(opts.dir, id + EVENTS_FILE_SUFFIX)
  const rotatedPath = (id: string): string => join(opts.dir, id + ROTATED_SUFFIX)

  const foldLines = (t: Tracked, lines: readonly string[]): void => {
    for (const line of lines) {
      const e = parseHookLine(line)
      if (e !== undefined) t.fold = applyHook(t.fold, e)
    }
  }

  const closeTail = (t: Tracked): void => {
    t.transcript?.watcher?.close()
    if (t.transcript) t.transcript.watcher = undefined
  }

  /** Open / close / read the transcript tail as the fold requires (may iterate once). */
  const syncTranscript = (id: string, t: Tracked): void => {
    for (let pass = 0; pass < 2; pass++) {
      const want = transcriptToTail(t.fold)
      if (want === undefined) {
        closeTail(t)
        return
      }
      if (t.transcript?.path !== want) {
        closeTail(t)
        t.transcript = { path: want, ...freshCursor() }
      }
      const tail = t.transcript
      if (tail.watcher === undefined) {
        try {
          tail.watcher = watchFn(want, () => schedule(id))
        } catch (err) {
          opts.onError?.(`cannot watch transcript ${want}: ${String(err)}`)
        }
      }
      const { lines } = readNewLines(want, tail, (size) => Math.max(0, size - tailBytes))
      const before = t.fold
      for (const line of lines) {
        const o = parseTranscriptLine(line)
        if (o !== undefined) t.fold = applyTranscript(t.fold, o)
      }
      if (t.fold === before) return
    }
  }

  const emit = (id: string, t: Tracked, force: boolean): void => {
    const { state, reason } = resolveFold(t.fold, now())
    if (!force && state === t.emitted) return
    t.emitted = state
    opts.sink(id, state, { reason })
  }

  const armDeadline = (id: string, t: Tracked): void => {
    if (t.deadline !== undefined) timers.clearTimer(t.deadline)
    t.deadline = undefined
    const at = nextDeadline(t.fold, now())
    if (at === undefined) return
    t.deadline = timers.setTimer(
      () => {
        t.deadline = undefined
        if (tracked.get(id) === t) settle(id, t, false)
      },
      Math.max(0, at - now())
    )
  }

  const maybeRotate = (id: string, t: Tracked): void => {
    if (t.events.offset <= maxEventsBytes || !atRest(t.fold)) return
    try {
      renameSync(eventsPath(id), rotatedPath(id))
    } catch (err) {
      opts.onError?.(`cannot rotate ${id}${EVENTS_FILE_SUFFIX}: ${String(err)}`)
      return
    }
    // A hook that opened the file just before the rename appends to `.1`: pick it up.
    const late: Cursor = { ...t.events }
    t.events = freshCursor()
    timers.setTimer(() => {
      if (tracked.get(id) !== t) return
      const { lines, replaced } = readNewLines(rotatedPath(id), late)
      if (replaced || lines.length === 0) return
      foldLines(t, lines)
      settle(id, t, false)
    }, ROTATE_LATE_TAIL_MS)
  }

  /** Read everything new for one session, then emit / re-arm / rotate. */
  const settle = (id: string, t: Tracked, force: boolean): void => {
    const { lines, replaced } = readNewLines(eventsPath(id), t.events)
    if (replaced) t.fold = initialFold()
    foldLines(t, lines)
    syncTranscript(id, t)
    t.fold = expireWakes(t.fold, now())
    emit(id, t, force)
    armDeadline(id, t)
    maybeRotate(id, t)
  }

  const schedule = (id: string): void => {
    const t = tracked.get(id)
    if (t === undefined || disposed) return
    if (t.debounce !== undefined) timers.clearTimer(t.debounce)
    t.debounce = timers.setTimer(() => {
      t.debounce = undefined
      if (tracked.get(id) === t) settle(id, t, false)
    }, debounceMs)
  }

  const untrack = (id: string): Tracked | undefined => {
    const t = tracked.get(id)
    if (t === undefined) return undefined
    if (t.debounce !== undefined) timers.clearTimer(t.debounce)
    if (t.deadline !== undefined) timers.clearTimer(t.deadline)
    closeTail(t)
    tracked.delete(id)
    return t
  }

  const replay = (id: string, emitted: SessionState): Tracked => {
    const t: Tracked = { fold: initialFold(), events: freshCursor(), emitted }
    tracked.set(id, t)
    const old = readNewLines(rotatedPath(id), freshCursor())
    foldLines(t, old.lines)
    return t
  }

  let dirWatcher: { close(): void } | undefined
  try {
    dirWatcher = watchFn(opts.dir, (filename) => {
      if (filename?.endsWith(EVENTS_FILE_SUFFIX)) {
        schedule(filename.slice(0, -EVENTS_FILE_SUFFIX.length))
      }
    })
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err))
  }

  return {
    attach: (id) => {
      if (disposed || tracked.has(id)) return
      settle(id, replay(id, SessionState.Unknown), false)
    },
    reset: (id) => {
      if (disposed) return
      const prev = untrack(id)
      unlinkQuietly(eventsPath(id))
      unlinkQuietly(rotatedPath(id))
      unlinkQuietly(join(opts.dir, id + '.json')) // pre-fold bridge state file
      unlinkQuietly(join(opts.dir, id + '.lock'))
      const t: Tracked = {
        fold: initialFold(),
        events: freshCursor(),
        emitted: prev?.emitted ?? SessionState.Unknown
      }
      tracked.set(id, t)
      emit(id, t, false)
    },
    rescan: (id) => {
      if (disposed) return
      const prev = untrack(id)
      settle(id, replay(id, prev?.emitted ?? SessionState.Unknown), true)
    },
    dispose: () => {
      disposed = true
      for (const id of [...tracked.keys()]) untrack(id)
      dirWatcher?.close()
      dirWatcher = undefined
    }
  }
}

/**
 * Delete event logs (and pre-fold bridge files) of sessions the workspace no longer
 * holds. Run once at startup, after hydrate. Keeps the saved original statusline.
 */
export function pruneClaudeStateDir(dir: string, keep: ReadonlySet<string>): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === ORIGINAL_STATUSLINE_FILE) continue
    const id = name.endsWith(ROTATED_SUFFIX)
      ? name.slice(0, -ROTATED_SUFFIX.length)
      : name.endsWith(EVENTS_FILE_SUFFIX)
        ? name.slice(0, -EVENTS_FILE_SUFFIX.length)
        : undefined
    const legacy = name.endsWith('.json') || name.endsWith('.lock') || name.includes('.json.tmp.')
    if ((id !== undefined && !keep.has(id)) || (id === undefined && legacy)) {
      unlinkQuietly(join(dir, name))
    }
  }
}
