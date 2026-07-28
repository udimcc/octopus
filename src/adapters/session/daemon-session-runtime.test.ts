import { describe, it, expect } from 'vitest'
import { DaemonSessionRuntime } from './daemon-session-runtime'
import type { DaemonClient, DaemonSessionSink } from './daemon-client'
import type { SpawnParams } from '../../shared/node/daemon-protocol'
import type { SessionRuntimeContext } from '../../ports/session-runtime'
import { asTaskId, asSessionId } from '../../domain/ids'

/**
 * A fake {@link DaemonClient} recording every call the runtime makes, capturing
 * the registered sink so the test can drive `onData`/`onExit`, and letting the
 * async methods resolve (or reject on demand to exercise start-failure).
 */
class FakeDaemonClient {
  readonly order: string[] = []
  readonly spawns: SpawnParams[] = []
  readonly attaches: string[] = []
  readonly writes: Array<{ id: string; data: string }> = []
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = []
  readonly detaches: string[] = []
  readonly closes: string[] = []
  readonly registered: string[] = []
  readonly unregistered: string[] = []

  sink: DaemonSessionSink | null = null

  attachAlive = true
  spawnReject: Error | null = null
  attachReject: Error | null = null

  registerSink(id: string, sink: DaemonSessionSink): void {
    this.order.push('registerSink')
    this.registered.push(id)
    this.sink = sink
  }

  unregisterSink(id: string): void {
    this.order.push('unregisterSink')
    this.unregistered.push(id)
  }

  async ensureReady(): Promise<void> {
    this.order.push('ensureReady')
  }

  async spawn(params: SpawnParams): Promise<number> {
    this.order.push('spawn')
    this.spawns.push(params)
    if (this.spawnReject) {
      throw this.spawnReject
    }
    return 4242
  }

  async attach(id: string): Promise<boolean> {
    this.order.push('attach')
    this.attaches.push(id)
    if (this.attachReject) {
      throw this.attachReject
    }
    return this.attachAlive
  }

  write(id: string, data: string): void {
    this.writes.push({ id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.resizes.push({ id, cols, rows })
  }

  detach(id: string): void {
    this.detaches.push(id)
  }

  async close(id: string): Promise<void> {
    this.order.push('close')
    this.closes.push(id)
  }
}

interface Harness {
  ctx: SessionRuntimeContext
  onData: string[]
  exits: Array<{ code?: number; signal?: number }>
  client: FakeDaemonClient
}

function harness(overrides: Partial<SessionRuntimeContext> = {}): Harness {
  const onData: string[] = []
  const exits: Array<{ code?: number; signal?: number }> = []
  const client = new FakeDaemonClient()
  const ctx: SessionRuntimeContext = {
    taskId: asTaskId('t1'),
    sessionId: asSessionId('s1'),
    worktreePath: '/wt/t1',
    cols: 100,
    rows: 40,
    env: { PATH: '/usr/bin' },
    stateSocketPath: '/run/octopus/s1.sock',
    onData: (d) => onData.push(d),
    onExit: (code, signal) => exits.push({ code, signal }),
    ...overrides
  }
  return { ctx, onData, exits, client }
}

function makeRuntime(h: Harness, args?: readonly string[]): DaemonSessionRuntime {
  return new DaemonSessionRuntime(h.ctx, {
    client: h.client as unknown as DaemonClient,
    shell: '/bin/zsh',
    args
  })
}

describe('DaemonSessionRuntime.start (§6.2)', () => {
  it('registers the sink BEFORE spawn and passes full spawnParams (fresh, no resume)', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()

    expect(h.client.order.indexOf('registerSink')).toBeLessThan(h.client.order.indexOf('spawn'))
    expect(h.client.attaches).toEqual([])
    expect(h.client.spawns).toHaveLength(1)
    expect(h.client.spawns[0]).toEqual({
      sessionId: 's1',
      taskId: 't1',
      shell: '/bin/zsh',
      args: ['-l'],
      cwd: '/wt/t1',
      cols: 100,
      rows: 40,
      stateSocketPath: '/run/octopus/s1.sock'
    })
  })

  it('attaches (not spawns) when ctx.resume is true', async () => {
    const h = harness({ resume: true })
    const rt = makeRuntime(h)
    await rt.start()

    expect(h.client.attaches).toEqual(['s1'])
    expect(h.client.spawns).toEqual([])
  })

  it('custom args override the default -l', async () => {
    const h = harness()
    const rt = makeRuntime(h, ['-c', 'echo hi'])
    await rt.start()

    expect(h.client.spawns[0].args).toEqual(['-c', 'echo hi'])
  })

  it('unregisters the sink and rethrows when spawn rejects (→ StartFailed)', async () => {
    const h = harness()
    h.client.spawnReject = new Error('spawn boom')
    const rt = makeRuntime(h)

    await expect(rt.start()).rejects.toThrow(/spawn boom/)
    expect(h.client.unregistered).toEqual(['s1'])
  })
})

describe('DaemonSessionRuntime output / exit routing', () => {
  it('forwards live output to ctx.onData', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()

    h.client.sink?.onData('hi')
    expect(h.onData).toEqual(['hi'])
  })

  it('a spontaneous exit routes to ctx.onExit and subsequent data is ignored', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()

    h.client.sink?.onExit(3, 15)
    expect(h.exits).toEqual([{ code: 3, signal: 15 }])

    h.client.sink?.onData('after-exit')
    expect(h.onData).toEqual([])
  })
})

describe('DaemonSessionRuntime.stop (§3.6)', () => {
  it('closes, unregisters, and suppresses ctx.onExit for the resulting death', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()

    await rt.stop()
    expect(h.client.closes).toEqual(['s1'])
    expect(h.client.unregistered).toEqual(['s1'])

    // A death arriving as a RESULT of our close must NOT surface as onExit.
    h.client.sink?.onExit(129, 1)
    expect(h.exits).toEqual([])
  })

  it('is a no-op before start (does not call close)', async () => {
    const h = harness()
    const rt = makeRuntime(h)

    await rt.stop()
    expect(h.client.closes).toEqual([])
  })
})

describe('DaemonSessionRuntime.write / resize', () => {
  it('forwards while alive and becomes a no-op after exit', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()

    rt.write('ls\n')
    rt.resize(120, 30)
    expect(h.client.writes).toEqual([{ id: 's1', data: 'ls\n' }])
    expect(h.client.resizes).toEqual([{ id: 's1', cols: 120, rows: 30 }])

    h.client.sink?.onExit(0)
    rt.write('ignored')
    rt.resize(10, 10)
    expect(h.client.writes).toEqual([{ id: 's1', data: 'ls\n' }])
    expect(h.client.resizes).toEqual([{ id: 's1', cols: 120, rows: 30 }])
  })
})

describe('DaemonSessionRuntime.dispose (§6.2)', () => {
  it('detaches (not closes) when not exited', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()

    rt.dispose()
    expect(h.client.unregistered).toEqual(['s1'])
    expect(h.client.detaches).toEqual(['s1'])
    expect(h.client.closes).toEqual([])
  })

  it('unregisters but does NOT detach after an exit', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()

    h.client.sink?.onExit(0)
    rt.dispose()
    expect(h.client.unregistered).toEqual(['s1'])
    expect(h.client.detaches).toEqual([])
  })
})

describe('DaemonSessionRuntime.stateEvaluator (§10)', () => {
  it('returns null in V1', async () => {
    const h = harness()
    const rt = makeRuntime(h)
    await rt.start()
    expect(rt.stateEvaluator()).toBeNull()
  })
})
