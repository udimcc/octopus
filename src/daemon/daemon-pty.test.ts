import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DaemonPty,
  type DaemonPtyProcess,
  type DaemonPtyDisposable,
  type DaemonPtySpawn,
  type DaemonPtySpawnOptions,
  type DaemonPtyOptions,
  type DaemonPtySink
} from './daemon-pty'

/** A fake node-pty recording writes/resizes/kills and letting the test drive callbacks. */
class FakePty implements DaemonPtyProcess {
  readonly pid = 4242
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  readonly kills: Array<string | undefined> = []
  private dataListener?: (data: string) => void
  private exitListener?: (e: { exitCode: number; signal?: number }) => void

  onData(listener: (data: string) => void): DaemonPtyDisposable {
    this.dataListener = listener
    return { dispose: () => undefined }
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): DaemonPtyDisposable {
    this.exitListener = listener
    return { dispose: () => undefined }
  }
  write(data: string): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }
  kill(signal?: string): void {
    this.kills.push(signal)
  }

  /** Test driver: emit output. */
  emitData(d: string): void {
    this.dataListener?.(d)
  }
  /** Test driver: emit a process exit. */
  emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal })
  }
}

/** Manual grace timers: capture scheduled callbacks so the test can fire them. */
function manualTimers(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  run: () => void
} {
  const cbs: Array<() => void> = []
  return {
    setTimer: (fn) => {
      cbs.push(fn)
      return cbs.length
    },
    clearTimer: () => undefined,
    run: () => {
      const pending = cbs.splice(0)
      for (const f of pending) f()
    }
  }
}

/** A sink recording batched output and spontaneous exits. */
function makeSink(): {
  data: string[]
  exits: Array<{ exitCode: number; signal?: number }>
  sink: DaemonPtySink
} {
  const data: string[] = []
  const exits: Array<{ exitCode: number; signal?: number }> = []
  return {
    data,
    exits,
    sink: {
      onData: (d) => data.push(d),
      onExit: (exitCode, signal) => exits.push({ exitCode, signal })
    }
  }
}

interface Harness {
  pty: DaemonPty
  fake: FakePty
  spawned: Array<{ file: string; args: string[]; options: DaemonPtySpawnOptions }>
  grace: ReturnType<typeof manualTimers>
}

function makeDaemon(overrides: Partial<DaemonPtyOptions> = {}): Harness {
  const fake = new FakePty()
  const spawned: Harness['spawned'] = []
  const spawn: DaemonPtySpawn = (file, args, options) => {
    spawned.push({ file, args, options })
    return fake
  }
  const grace = manualTimers()
  const pty = new DaemonPty({
    spawn,
    shell: '/bin/bash',
    args: ['-l'],
    cwd: '/wt/t1',
    cols: 80,
    rows: 24,
    env: { TERM: 'xterm-256color', PATH: '/usr/bin' },
    bufferBytes: 4096,
    graceMs: 2000,
    setTimer: grace.setTimer,
    clearTimer: grace.clearTimer,
    ...overrides
  })
  return { pty, fake, spawned, grace }
}

/**
 * Emit output and flush the server-side batcher. The batcher uses the real global
 * timers (DaemonPty does not inject its timers into it), so fake timers let us fire
 * the trailing coalesce window deterministically. Leading-edge already flushes the
 * first idle chunk synchronously; running the timers drains any coalesced follow-ups.
 */
function emit(fake: FakePty, data: string): void {
  fake.emitData(data)
  vi.runAllTimers()
}

describe('DaemonPty (§6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes shell/args/cwd/cols/rows/env through to the injected spawn', () => {
    const h = makeDaemon()
    expect(h.spawned).toHaveLength(1)
    const s = h.spawned[0]
    expect(s.file).toBe('/bin/bash')
    expect(s.args).toEqual(['-l'])
    expect(s.options.name).toBe('xterm-256color')
    expect(s.options.cols).toBe(80)
    expect(s.options.rows).toBe(24)
    expect(s.options.cwd).toBe('/wt/t1')
    expect(s.options.env).toEqual({ TERM: 'xterm-256color', PATH: '/usr/bin' })
  })

  it('replays the retained snapshot synchronously on attach, then streams live output', () => {
    const h = makeDaemon()
    // Output produced with no client attached is retained in the ring buffer.
    emit(h.fake, 'before-')
    emit(h.fake, 'attach')

    const client = makeSink()
    const alive = h.pty.attach(client.sink)
    expect(alive).toBe(true)
    // The snapshot arrives immediately, ahead of any live output.
    expect(client.data).toEqual(['before-attach'])

    // Further output now streams live to the attached sink.
    emit(h.fake, 'live')
    expect(client.data).toEqual(['before-attach', 'live'])
  })

  it('attach returns true while alive and a second attach replaces the prior sink', () => {
    const h = makeDaemon()
    const first = makeSink()
    const second = makeSink()

    expect(h.pty.attach(first.sink)).toBe(true)
    expect(h.pty.attach(second.sink)).toBe(true)

    emit(h.fake, 'x')
    // Only the current (second) sink receives subsequent live data.
    expect(second.data).toEqual(['x'])
    expect(first.data).toEqual([])
  })

  it('keeps buffering while detached; a re-attach snapshot includes data buffered while detached', () => {
    const h = makeDaemon()
    const first = makeSink()
    h.pty.attach(first.sink)
    emit(h.fake, 'one')
    expect(first.data).toEqual(['one'])

    h.pty.detach()
    // No sink attached, but the PTY keeps buffering.
    emit(h.fake, 'two')
    expect(first.data).toEqual(['one'])

    const second = makeSink()
    h.pty.attach(second.sink)
    // The replay snapshot includes output buffered while detached.
    expect(second.data).toEqual(['onetwo'])
  })

  it('a spontaneous exit fires the sink onExit, flips alive, and records exitInfo', () => {
    const h = makeDaemon()
    const client = makeSink()
    h.pty.attach(client.sink)

    h.fake.emitExit(3, 15)

    expect(client.exits).toEqual([{ exitCode: 3, signal: 15 }])
    expect(h.pty.alive).toBe(false)
    expect(h.pty.exitInfo).toEqual({ exitCode: 3, signal: 15 })
  })

  it('close() SIGHUPs then escalates to SIGKILL after the grace timer, resolving the promise', async () => {
    const h = makeDaemon()
    const closed = h.pty.close()
    expect(h.fake.kills).toEqual(['SIGHUP'])

    // The process ignores SIGHUP: firing the grace timer escalates to SIGKILL.
    h.grace.run()
    expect(h.fake.kills).toEqual(['SIGHUP', 'SIGKILL'])
    await expect(closed).resolves.toBeUndefined()
  })

  it('once close() is stopping, a resulting exit suppresses sink onExit (close owns resolution)', async () => {
    const h = makeDaemon()
    const client = makeSink()
    h.pty.attach(client.sink)

    const closed = h.pty.close()
    expect(h.fake.kills).toEqual(['SIGHUP'])

    // The process dies as a RESULT of our SIGHUP: onExit must be suppressed.
    h.fake.emitExit(129, 1)
    expect(client.exits).toEqual([])
    expect(h.pty.alive).toBe(false)
    await expect(closed).resolves.toBeUndefined()
  })

  it('write/resize are no-ops after exit; resize before exit updates dims and calls pty.resize', () => {
    const h = makeDaemon()

    h.pty.resize(120, 40)
    expect(h.fake.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(h.pty.currentCols).toBe(120)
    expect(h.pty.currentRows).toBe(40)

    h.pty.write('hi')
    expect(h.fake.writes).toEqual(['hi'])

    h.fake.emitExit(0)

    h.pty.write('after')
    h.pty.resize(10, 10)
    // No new pty.write / pty.resize once the process has exited.
    expect(h.fake.writes).toEqual(['hi'])
    expect(h.fake.resizes).toEqual([{ cols: 120, rows: 40 }])
  })

  it('close() on an already-exited pty resolves immediately without killing', async () => {
    const h = makeDaemon()
    h.fake.emitExit(0)

    const closed = h.pty.close()
    expect(h.fake.kills).toEqual([])
    await expect(closed).resolves.toBeUndefined()
  })
})
