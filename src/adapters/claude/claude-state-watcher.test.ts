import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createClaudeStateWatcher,
  pruneClaudeStateDir,
  type ClaudeStateWatcher,
  type ClaudeStateWatcherOptions,
  type WatchFn
} from './claude-state-watcher'
import { WAKE_GRACE_MS } from './claude-session-fold'
import { SessionState } from '../../domain/state'

const FIXTURES = join(__dirname, '../../../test/fixtures/claude-state')
const { Unknown, Idle, Working, NeedsInput } = SessionState

/** Manual timers + clock: `advance(ms)` runs due timers in time order. */
function manualTime(start = 1_000_000): {
  timers: NonNullable<ClaudeStateWatcherOptions['timers']>
  now: () => number
  advance(ms: number): void
  pending(): number
} {
  let clock = start
  let seq = 0
  const queue = new Map<number, { at: number; fn: () => void }>()
  return {
    timers: {
      setTimer: (fn, ms) => {
        queue.set(++seq, { at: clock + ms, fn })
        return seq
      },
      clearTimer: (h) => void queue.delete(h as number)
    },
    now: () => clock,
    advance(ms) {
      const end = clock + ms
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (due === undefined) break
        queue.delete(due[0])
        clock = Math.max(clock, due[1].at)
        due[1].fn()
      }
      clock = end
    },
    pending: () => queue.size
  }
}

/** A fake `fs.watch`: tests fire change notifications explicitly. */
function fakeWatch(): WatchFn & {
  fire(path: string, filename?: string): void
  open(): string[]
} {
  const subs = new Map<number, { path: string; cb: (f?: string) => void }>()
  let seq = 0
  const fn = ((path: string, cb: (f?: string) => void) => {
    const id = ++seq
    subs.set(id, { path, cb })
    return { close: () => void subs.delete(id) }
  }) as WatchFn & { fire(path: string, filename?: string): void; open(): string[] }
  fn.fire = (path, filename) => {
    for (const s of [...subs.values()]) if (s.path === path) s.cb(filename)
  }
  fn.open = () => [...subs.values()].map((s) => s.path)
  return fn
}

describe('createClaudeStateWatcher', () => {
  let dir: string
  let watcher: ClaudeStateWatcher | undefined
  let time: ReturnType<typeof manualTime>
  let fsw: ReturnType<typeof fakeWatch>
  let seen: Array<[string, SessionState, string | undefined]>
  const ID = 'sess-1'
  const log = (): string => join(dir, ID + '.events.jsonl')

  let t = 1_000_000
  const line = (ev: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ v: 1, t: (t += 10), ev, sid: 'S', prm: 'p1', ...extra }) + '\n'
  const append = (...lines: string[]): void => appendFileSync(log(), lines.join(''))
  /** Notify the watcher of an append and let the debounce settle. */
  const settle = (): void => {
    fsw.fire(dir, ID + '.events.jsonl')
    time.advance(50)
  }
  const states = (): SessionState[] => seen.map(([, s]) => s)

  const start = (extra: Partial<ClaudeStateWatcherOptions> = {}): ClaudeStateWatcher => {
    watcher = createClaudeStateWatcher({
      dir,
      sink: (id, state, meta) => seen.push([id, state, meta?.reason]),
      timers: time.timers,
      now: time.now,
      watch: fsw,
      ...extra
    })
    return watcher
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-claude-state-'))
    time = manualTime()
    t = time.now()
    fsw = fakeWatch()
    seen = []
  })

  afterEach(() => {
    watcher?.dispose()
    watcher = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('attach replays the whole log (re-attach after an app restart)', () => {
    append(line('UserPromptSubmit'), line('PreToolUse', { tool: 'Bash', tu: 'a', ih: 'h' }))
    start().attach(ID)
    expect(seen).toEqual([[ID, Working, 'lead_working <- PreToolUse']])
  })

  it('attach replays the live trace + its transcript to the right final state', () => {
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(transcript, readFileSync(join(FIXTURES, 'transcript-2bg-perm.jsonl')))
    const golden = readFileSync(join(FIXTURES, 'trace-2bg-perm.events.jsonl'), 'utf8')
    writeFileSync(log(), golden.replace(/"tp":"[^"]*"/g, `"tp":${JSON.stringify(transcript)}`))
    time.advance(golden.length) // any time well after the trace
    start().attach(ID)
    // The denied permission fired no hook; the transcript's interrupt marker ends it.
    expect(states()).toEqual([Idle])
  })

  it('ignores logs of sessions it does not track', () => {
    start()
    appendFileSync(join(dir, 'other.events.jsonl'), line('UserPromptSubmit'))
    fsw.fire(dir, 'other.events.jsonl')
    time.advance(50)
    expect(seen).toEqual([])
  })

  it('follows appends, debounced, and emits only on a state change', () => {
    start().attach(ID)
    expect(seen).toEqual([]) // empty log → Unknown → nothing to say
    append(line('UserPromptSubmit'))
    fsw.fire(dir, ID + '.events.jsonl')
    expect(seen).toEqual([]) // still debouncing
    time.advance(50)
    append(line('PreToolUse', { tool: 'Bash', tu: 'a' }))
    settle()
    append(line('Stop'))
    settle()
    expect(states()).toEqual([Working, Idle])
  })

  it('holds a partial trailing line until it is completed', () => {
    start().attach(ID)
    const full = line('UserPromptSubmit')
    appendFileSync(log(), full.slice(0, 20))
    settle()
    expect(seen).toEqual([])
    appendFileSync(log(), full.slice(20))
    settle()
    expect(states()).toEqual([Working])
  })

  it('re-folds from scratch when the log is replaced', () => {
    append(line('UserPromptSubmit'), line('PreToolUse', { tool: 'Bash', tu: 'a', ih: 'h' }))
    start().attach(ID)
    rmSync(log())
    append(line('SessionStart', { src: 'startup' }))
    settle()
    expect(states()).toEqual([Working, Idle])
  })

  it('reset (fresh terminal) deletes the log + legacy files and reports Unknown', () => {
    append(line('UserPromptSubmit'))
    writeFileSync(join(dir, ID + '.json'), '{}')
    writeFileSync(join(dir, ID + '.lock'), '')
    const w = start()
    w.attach(ID)
    w.reset(ID)
    expect(states()).toEqual([Working, Unknown])
    expect(readdirSync(dir)).toEqual([])
    append(line('SessionStart', { src: 'startup' }))
    settle()
    expect(states()).toEqual([Working, Unknown, Idle])
  })

  it('reset of a never-seen session says nothing (it is already Unknown)', () => {
    append(line('UserPromptSubmit'))
    start().reset(ID)
    expect(seen).toEqual([])
    expect(existsSync(log())).toBe(false)
  })

  it('re-resolves on a timer when a finished agent’s result is never picked up', () => {
    start().attach(ID)
    append(
      line('UserPromptSubmit'),
      line('PostToolUse', { tool: 'Agent', tu: 'x', bga: 'A' }),
      line('Stop', { bg: [{ id: 'A', ty: 'subagent', st: 'running' }] })
    )
    settle()
    t = time.now()
    append(line('SubagentStop', { aid: 'A' }))
    settle()
    expect(states()).toEqual([Working])
    time.advance(WAKE_GRACE_MS)
    expect(states()).toEqual([Working, Idle])
    expect(time.pending()).toBe(0)
  })

  it('tails the transcript only during an open turn and reads an interrupt from it', () => {
    const transcript = join(dir, 't.jsonl')
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'old' } }) + '\n')
    start().attach(ID)
    t = time.now()
    append(
      line('UserPromptSubmit', { tp: transcript }),
      line('PreToolUse', { tool: 'Bash', tu: 'b', ih: 'h' })
    )
    append(line('PermissionRequest', { tool: 'Bash', ih: 'h' }))
    settle()
    expect(states()).toEqual([NeedsInput])
    expect(fsw.open()).toContain(transcript)
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        promptId: 'p1',
        timestamp: new Date(time.now() + 5_000).toISOString(),
        message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }
      }) + '\n'
    )
    fsw.fire(transcript)
    time.advance(50)
    expect(states()).toEqual([NeedsInput, Idle])
    expect(fsw.open()).not.toContain(transcript) // turn over → tail closed
  })

  it('rotates a large log at rest and still replays both parts', () => {
    const w = start({ maxEventsBytes: 100 })
    w.attach(ID)
    append(line('UserPromptSubmit'), line('PreToolUse', { tool: 'Bash', tu: 'a' }), line('Stop'))
    settle()
    expect(existsSync(join(dir, ID + '.events.1.jsonl'))).toBe(true)
    expect(existsSync(log())).toBe(false)
    append(line('UserPromptSubmit', { prm: 'p2' }))
    settle()
    expect(states()).toEqual([Idle, Working]) // the first turn settled in one read
    seen = []
    w.rescan(ID)
    expect(seen).toEqual([[ID, Working, 'lead_working <- UserPromptSubmit']])
  })

  it('rotates once a wake-up that never came has expired', () => {
    start({ maxEventsBytes: 100 }).attach(ID)
    t = time.now()
    append(
      line('UserPromptSubmit'),
      line('PostToolUse', { tool: 'Agent', tu: 'x', bga: 'A' }),
      line('Stop', { bg: [{ id: 'A', ty: 'subagent', st: 'running' }] }),
      line('SubagentStop', { aid: 'A' })
    )
    settle()
    expect(existsSync(join(dir, ID + '.events.1.jsonl'))).toBe(false)
    time.advance(WAKE_GRACE_MS)
    expect(states()).toEqual([Working, Idle])
    expect(existsSync(join(dir, ID + '.events.1.jsonl'))).toBe(true)
  })

  it('does not rotate while work is in flight', () => {
    start({ maxEventsBytes: 100 }).attach(ID)
    append(line('UserPromptSubmit'), line('PreToolUse', { tool: 'Bash', tu: 'a' }))
    settle()
    expect(existsSync(log())).toBe(true)
    expect(existsSync(join(dir, ID + '.events.1.jsonl'))).toBe(false)
  })

  it('rescan re-emits the current state even when unchanged', () => {
    append(line('UserPromptSubmit'))
    const w = start()
    w.attach(ID)
    w.rescan(ID)
    expect(states()).toEqual([Working, Working])
  })

  it('dispose stops watching and clears timers', () => {
    const w = start()
    w.attach(ID)
    append(line('UserPromptSubmit'))
    fsw.fire(dir, ID + '.events.jsonl')
    w.dispose()
    time.advance(100)
    expect(seen).toEqual([])
    expect(fsw.open()).toEqual([])
    expect(time.pending()).toBe(0)
  })
})

describe('pruneClaudeStateDir', () => {
  it('deletes logs of unknown sessions and every pre-fold bridge file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopus-claude-prune-'))
    try {
      for (const name of [
        'keep.events.jsonl',
        'keep.events.1.jsonl',
        'gone.events.jsonl',
        'gone.events.1.jsonl',
        'keep.json',
        'keep.lock',
        'x.json.tmp.123',
        'original-statusline'
      ]) {
        writeFileSync(join(dir, name), '')
      }
      pruneClaudeStateDir(dir, new Set(['keep']))
      expect(readdirSync(dir).sort()).toEqual([
        'keep.events.1.jsonl',
        'keep.events.jsonl',
        'original-statusline'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tolerates a missing dir', () => {
    expect(() => pruneClaudeStateDir('/nonexistent/octopus', new Set())).not.toThrow()
  })
})
