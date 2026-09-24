import { describe, it, expect } from 'vitest'
import {
  PtyTerminalRuntime,
  type PtyProcess,
  type PtySpawn,
  type PtySpawnOptions,
  type PtyDisposable
} from './pty-terminal-runtime'
import type { BatcherTimers } from '../../shared/node/output-batcher'
import type { SessionRuntimeContext } from '../../ports/session-runtime'
import { asTaskId, asSessionId } from '../../domain/ids'

/** A fake IPty recording writes/resizes/kills and letting the test drive callbacks. */
class FakePty implements PtyProcess {
  readonly pid = 4242
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  readonly kills: Array<string | undefined> = []
  private dataListener?: (data: string) => void
  private exitListener?: (e: { exitCode: number; signal?: number }) => void
  dataDisposed = false
  exitDisposed = false

  onData(listener: (data: string) => void): PtyDisposable {
    this.dataListener = listener
    return { dispose: () => (this.dataDisposed = true) }
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): PtyDisposable {
    this.exitListener = listener
    return { dispose: () => (this.exitDisposed = true) }
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

/** Immediate timers: fire the scheduled callback synchronously, so we can inspect it. */
function manualTimers(): BatcherTimers & { run: () => void } {
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

interface Harness {
  ctx: SessionRuntimeContext
  onData: string[]
  exits: Array<{ code?: number; signal?: number }>
  spawned: Array<{ file: string; args: string[]; options: PtySpawnOptions }>
  fakePty: FakePty
  spawn: PtySpawn
}

function harness(): Harness {
  const onData: string[] = []
  const exits: Array<{ code?: number; signal?: number }> = []
  const spawned: Harness['spawned'] = []
  const fakePty = new FakePty()
  const spawn: PtySpawn = (file, args, options) => {
    spawned.push({ file, args, options })
    return fakePty
  }
  const ctx: SessionRuntimeContext = {
    taskId: asTaskId('t1'),
    sessionId: asSessionId('s1'),
    worktreePath: '/wt/t1',
    cols: 100,
    rows: 40,
    env: { PATH: '/usr/bin', TMUX: 'x' },
    onData: (d) => onData.push(d),
    onExit: (code, signal) => exits.push({ code, signal })
  }
  return { ctx, onData, exits, spawned, fakePty, spawn }
}

describe('PtyTerminalRuntime.start (§6.1)', () => {
  it('spawns a login shell at the worktree cwd with the built env', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/zsh' })
    await rt.start()

    expect(h.spawned).toHaveLength(1)
    const s = h.spawned[0]
    expect(s.file).toBe('/bin/zsh')
    expect(s.args).toEqual(['-l'])
    expect(s.options.name).toBe('xterm-256color')
    expect(s.options.cols).toBe(100)
    expect(s.options.rows).toBe(40)
    expect(s.options.cwd).toBe('/wt/t1')
    // env is built via buildPtyEnv: TMUX stripped, OCTOPUS_* + TERM added.
    expect(s.options.env.TMUX).toBeUndefined()
    expect(s.options.env.TERM).toBe('xterm-256color')
    expect(s.options.env.OCTOPUS_SESSION_ID).toBe('s1')
    expect(s.options.env.PATH).toBe('/usr/bin')
  })

  it('honours custom args and layers envPatch onto the built env (§12.1 injection)', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, {
      spawn: h.spawn,
      shell: '/bin/bash',
      args: ['--rcfile', '/data/octopus.bashrc', '-i'],
      envPatch: { OCTOPUS_USER_BASHRC: '/home/dev/.bashrc' }
    })
    await rt.start()

    const s = h.spawned[0]
    expect(s.args).toEqual(['--rcfile', '/data/octopus.bashrc', '-i'])
    expect(s.options.env.OCTOPUS_USER_BASHRC).toBe('/home/dev/.bashrc')
    // envPatch is layered on TOP of buildPtyEnv, not instead of it.
    expect(s.options.env.TERM).toBe('xterm-256color')
    expect(s.options.env.OCTOPUS_SESSION_ID).toBe('s1')
  })

  it('rejects (→ StartFailed) when spawn throws', async () => {
    const h = harness()
    const spawn: PtySpawn = () => {
      throw new Error('spawn boom')
    }
    const rt = new PtyTerminalRuntime(h.ctx, { spawn, shell: '/bin/bash' })
    await expect(rt.start()).rejects.toThrow(/spawn boom/)
  })

  it('batches PTY output through to ctx.onData (leading edge + trailing coalesce)', async () => {
    const timers = manualTimers()
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash', timers })
    await rt.start()

    h.fakePty.emitData('foo') // idle buffer → flushed immediately (§11 <5 ms)
    h.fakePty.emitData('bar') // within the trailing window → queued
    expect(h.onData).toEqual(['foo'])
    timers.run()
    expect(h.onData).toEqual(['foo', 'bar'])
  })
})

describe('PtyTerminalRuntime.write / resize', () => {
  it('forwards writes to the pty', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash' })
    await rt.start()
    rt.write('ls\n')
    expect(h.fakePty.writes).toEqual(['ls\n'])
  })

  it('forwards resizes and swallows a resize on a dead pty', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash' })
    await rt.start()
    rt.resize(120, 30)
    expect(h.fakePty.resizes).toEqual([{ cols: 120, rows: 30 }])

    // A throwing resize (process already gone) must not propagate.
    const throwing = new FakePty()
    throwing.resize = () => {
      throw new Error('dead')
    }
    const spawn2: PtySpawn = () => throwing
    const rt2 = new PtyTerminalRuntime(h.ctx, { spawn: spawn2, shell: '/bin/bash' })
    await rt2.start()
    expect(() => rt2.resize(10, 10)).not.toThrow()
  })
})

describe('PtyTerminalRuntime spontaneous exit vs user stop (§3.6/§6.1)', () => {
  it('a spontaneous exit fires ctx.onExit and flushes buffered output', async () => {
    const timers = manualTimers()
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash', timers })
    await rt.start()

    h.fakePty.emitData('final ') // leads (idle) → emitted immediately
    h.fakePty.emitData('output') // within the trailing window → queued, not yet flushed
    expect(h.onData).toEqual(['final '])
    h.fakePty.emitExit(0)

    // Exit flushes the queued window immediately (no timer wait), then signals onExit.
    expect(h.onData).toEqual(['final ', 'output'])
    expect(h.exits).toEqual([{ code: 0, signal: undefined }])
  })

  it('stop() SIGHUPs, suppresses ctx.onExit, and escalates to SIGKILL after grace', async () => {
    const timers = manualTimers()
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, {
      spawn: h.spawn,
      shell: '/bin/bash',
      graceMs: 2000,
      timers
    })
    await rt.start()

    const stopped = rt.stop()
    expect(h.fakePty.kills).toEqual(['SIGHUP'])

    // The process dies as a RESULT of our SIGHUP — onExit must be SUPPRESSED
    // (close-session owns Stopping → Closed; no Closed → Exited race).
    h.fakePty.emitExit(129, 1)
    expect(h.exits).toEqual([])
    await expect(stopped).resolves.toBeUndefined()
  })

  it('stop() escalates to SIGKILL when the process ignores SIGHUP past the grace window', async () => {
    const timers = manualTimers()
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, {
      spawn: h.spawn,
      shell: '/bin/bash',
      graceMs: 2000,
      timers
    })
    await rt.start()

    const stopped = rt.stop()
    expect(h.fakePty.kills).toEqual(['SIGHUP'])
    // Fire the grace timer without the process having exited.
    timers.run()
    expect(h.fakePty.kills).toEqual(['SIGHUP', 'SIGKILL'])
    await expect(stopped).resolves.toBeUndefined()
  })

  it('stop() on an already-exited runtime resolves without signalling', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash' })
    await rt.start()
    h.fakePty.emitExit(0)
    await expect(rt.stop()).resolves.toBeUndefined()
    expect(h.fakePty.kills).toEqual([])
  })

  it('dispose() releases listeners and SIGKILLs a still-live child', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash' })
    await rt.start()
    rt.dispose()
    expect(h.fakePty.dataDisposed).toBe(true)
    expect(h.fakePty.exitDisposed).toBe(true)
    expect(h.fakePty.kills).toEqual(['SIGKILL'])
  })
})

describe('PtyTerminalRuntime.currentCwd (§6.1, "new terminal here")', () => {
  it('resolves undefined before start (no live pid)', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash' })
    await expect(rt.currentCwd()).resolves.toBeUndefined()
  })

  it('resolves undefined after the process exits', async () => {
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash' })
    await rt.start()
    h.fakePty.emitExit(0)
    await expect(rt.currentCwd()).resolves.toBeUndefined()
  })

  it('reads /proc/<pid>/cwd for a live pid (undefined when the pid is not a real process)', async () => {
    // The fake pty reports pid 4242; procCwd reads the REAL /proc, which has no
    // such process here, so the live path returns undefined without throwing.
    const h = harness()
    const rt = new PtyTerminalRuntime(h.ctx, { spawn: h.spawn, shell: '/bin/bash' })
    await rt.start()
    await expect(rt.currentCwd()).resolves.toBeUndefined()
  })
})
