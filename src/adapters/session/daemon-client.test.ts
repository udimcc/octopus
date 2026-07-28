import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { DaemonClient, type DaemonSessionSink } from './daemon-client'
import {
  FrameDecoder,
  encodeControl,
  encodeData,
  PROTOCOL_VERSION,
  type ControlMessage,
  type SpawnParams
} from '../../shared/node/daemon-protocol'

/** Drain the microtask (and immediate) queue so the client's async flow settles. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * A fake `net.Socket`: records + decodes everything the client writes so the test
 * can inspect the outgoing ClientMessages / DATA frames, and lets the test drive
 * the peer by `emit`-ing `'connect'` / `'data'` / `'close'` / `'error'`.
 */
class FakeSocket extends EventEmitter {
  destroyed = false
  readonly written: Buffer[] = []
  private readonly decoder = new FrameDecoder()
  readonly outFrames = this.decoder.push(Buffer.alloc(0)) // typed Frame[]

  write(buf: Buffer): boolean {
    this.written.push(buf)
    for (const frame of this.decoder.push(buf)) {
      this.outFrames.push(frame)
    }
    return true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }

  /** Outgoing control messages, in send order. */
  controls(): ControlMessage[] {
    return this.outFrames
      .filter((f) => f.kind === 'control')
      .map((f) => (f as { kind: 'control'; message: ControlMessage }).message)
  }

  /** Outgoing DATA frames, in send order. */
  dataFrames(): Array<{ sessionId: string; data: string }> {
    return this.outFrames
      .filter((f) => f.kind === 'data')
      .map((f) => f as { kind: 'data'; sessionId: string; data: string })
  }
}

interface Harness {
  client: DaemonClient
  sockets: FakeSocket[]
  timers: Array<() => void>
  launchFn: ReturnType<typeof vi.fn>
  connectFn: ReturnType<typeof vi.fn>
}

function makeClient(overrides: Record<string, unknown> = {}): Harness {
  const sockets: FakeSocket[] = []
  const timers: Array<() => void> = []
  const launchFn = vi.fn(() => true)
  const connectFn = vi.fn(() => {
    const sock = new FakeSocket()
    sockets.push(sock)
    return sock as unknown as Socket
  })
  const client = new DaemonClient({
    socketPath: '/tmp/octopusd.sock',
    daemonEntry: '/tmp/daemon.js',
    connectTimeoutMs: 1000,
    connectRetryMs: 10,
    connectFn,
    launchFn,
    setTimer: (fn: () => void) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
    ...overrides
  })
  return { client, sockets, timers, launchFn, connectFn }
}

/** Reply to the (already-sent) `hello` on `sock` with a matching-requestId helloAck. */
function ackHello(sock: FakeSocket, protocolVersion: number = PROTOCOL_VERSION): void {
  const hello = sock.controls().find((m) => m.type === 'hello')
  if (!hello || hello.type !== 'hello') {
    throw new Error('test bug: no hello frame was sent')
  }
  sock.emit(
    'data',
    encodeControl({
      type: 'helloAck',
      requestId: hello.requestId,
      protocolVersion,
      daemonVersion: '1.2.3'
    })
  )
}

/** Bring a client to the ready state over the first (successful) connect. */
async function connectReady(h: Harness): Promise<void> {
  const p = h.client.ensureReady()
  h.sockets[0].emit('connect')
  await flush()
  ackHello(h.sockets[0])
  await p
}

const spawnParams: SpawnParams = {
  sessionId: 's1',
  taskId: 't1',
  shell: '/bin/bash',
  args: ['-l'],
  cwd: '/home/dev',
  cols: 80,
  rows: 24
}

describe('DaemonClient', () => {
  it('connects (no launch) when the first connect succeeds and completes the handshake', async () => {
    const h = makeClient()
    const p = h.client.ensureReady()
    expect(h.connectFn).toHaveBeenCalledTimes(1)

    h.sockets[0].emit('connect')
    await flush()

    const hello = h.sockets[0].controls().find((m) => m.type === 'hello')
    expect(hello).toBeDefined()
    if (hello && hello.type === 'hello') {
      expect(hello.protocolVersion).toBe(PROTOCOL_VERSION)
    }

    ackHello(h.sockets[0])
    await expect(p).resolves.toBeUndefined()
    expect(h.launchFn).not.toHaveBeenCalled()
  })

  it('launches then retries when the first connect fails, succeeding on the retry', async () => {
    const h = makeClient()
    const p = h.client.ensureReady()

    // First attempt fails.
    h.sockets[0].emit('error', new Error('ECONNREFUSED'))
    await flush()
    expect(h.launchFn).toHaveBeenCalledTimes(1)
    expect(h.timers.length).toBe(1)

    // Fire the backoff timer → second connect attempt.
    h.timers[0]()
    await flush()
    expect(h.connectFn).toHaveBeenCalledTimes(2)

    h.sockets[1].emit('connect')
    await flush()
    ackHello(h.sockets[1])

    await expect(p).resolves.toBeUndefined()
  })

  it('rejects with a launch failure when connect fails and launchFn returns false', async () => {
    const h = makeClient({ launchFn: vi.fn(() => false) })
    const p = h.client.ensureReady()
    h.sockets[0].emit('error', new Error('ECONNREFUSED'))
    await expect(p).rejects.toThrow('failed to launch octopusd')
  })

  it('coalesces concurrent ensureReady calls into one connect attempt', async () => {
    const h = makeClient()
    const p1 = h.client.ensureReady()
    const p2 = h.client.ensureReady()
    expect(h.connectFn).toHaveBeenCalledTimes(1)

    h.sockets[0].emit('connect')
    await flush()
    ackHello(h.sockets[0])

    await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined])
  })

  it('rejects when helloAck carries a mismatched protocol version', async () => {
    const h = makeClient()
    const p = h.client.ensureReady()
    h.sockets[0].emit('connect')
    await flush()
    ackHello(h.sockets[0], PROTOCOL_VERSION + 999)
    await expect(p).rejects.toThrow(/protocol/)
  })

  it('spawn sends a spawn control frame and resolves with the pid on spawned', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const p = h.client.spawn(spawnParams)
    const spawnMsg = sock.controls().find((m) => m.type === 'spawn')
    expect(spawnMsg).toBeDefined()
    if (spawnMsg && spawnMsg.type === 'spawn') {
      expect(spawnMsg.params).toEqual(spawnParams)
      sock.emit(
        'data',
        encodeControl({
          type: 'spawned',
          requestId: spawnMsg.requestId,
          sessionId: spawnParams.sessionId,
          pid: 4321
        })
      )
    }
    await expect(p).resolves.toBe(4321)
  })

  it('spawn rejects with the message from a spawnError reply', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const p = h.client.spawn(spawnParams)
    const spawnMsg = sock.controls().find((m) => m.type === 'spawn')
    if (spawnMsg && spawnMsg.type === 'spawn') {
      sock.emit(
        'data',
        encodeControl({
          type: 'spawnError',
          requestId: spawnMsg.requestId,
          sessionId: spawnParams.sessionId,
          message: 'no such shell'
        })
      )
    }
    await expect(p).rejects.toThrow('no such shell')
  })

  it('attach sends an attach frame and resolves with alive from the reply', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const p = h.client.attach('s1')
    const attachMsg = sock.controls().find((m) => m.type === 'attach')
    expect(attachMsg).toBeDefined()
    if (attachMsg && attachMsg.type === 'attach') {
      expect(attachMsg.sessionId).toBe('s1')
      sock.emit(
        'data',
        encodeControl({
          type: 'attached',
          requestId: attachMsg.requestId,
          sessionId: 's1',
          alive: true
        })
      )
    }
    await expect(p).resolves.toBe(true)
  })

  it('listSessions sends a listSessions frame and resolves with the sessions array', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const p = h.client.listSessions()
    const listMsg = sock.controls().find((m) => m.type === 'listSessions')
    expect(listMsg).toBeDefined()
    const sessions = [
      { sessionId: 's1', alive: true, pid: 10, cols: 80, rows: 24 },
      { sessionId: 's2', alive: false, pid: 11, cols: 120, rows: 40 }
    ]
    if (listMsg && listMsg.type === 'listSessions') {
      sock.emit('data', encodeControl({ type: 'sessions', requestId: listMsg.requestId, sessions }))
    }
    await expect(p).resolves.toEqual(sessions)
  })

  it('fans an inbound DATA frame to the matching sink and drops unknown ids', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const sink: DaemonSessionSink = { onData: vi.fn(), onExit: vi.fn() }
    h.client.registerSink('s1', sink)

    sock.emit('data', encodeData('s1', 'hello'))
    expect(sink.onData).toHaveBeenCalledWith('hello')

    sock.emit('data', encodeData('unknown', 'ignored'))
    expect(sink.onData).toHaveBeenCalledTimes(1)
  })

  it('routes an unsolicited exit frame to the sink and drops the sink afterwards', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const sink: DaemonSessionSink = { onData: vi.fn(), onExit: vi.fn() }
    h.client.registerSink('s1', sink)

    sock.emit('data', encodeControl({ type: 'exit', sessionId: 's1', exitCode: 7, signal: 15 }))
    expect(sink.onExit).toHaveBeenCalledWith(7, 15)

    // Second exit for the same id is a no-op (sink already deleted).
    sock.emit('data', encodeControl({ type: 'exit', sessionId: 's1', exitCode: 0 }))
    expect(sink.onExit).toHaveBeenCalledTimes(1)
  })

  it('write emits a DATA frame; resize/detach emit their control frames', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    h.client.write('s1', 'ls -la\n')
    const data = sock.dataFrames().find((f) => f.sessionId === 's1')
    expect(data).toEqual({ kind: 'data', sessionId: 's1', data: 'ls -la\n' })

    h.client.resize('s1', 100, 30)
    const resize = sock.controls().find((m) => m.type === 'resize')
    expect(resize).toEqual({ type: 'resize', sessionId: 's1', cols: 100, rows: 30 })

    h.client.detach('s1')
    const detach = sock.controls().find((m) => m.type === 'detach')
    expect(detach).toEqual({ type: 'detach', sessionId: 's1' })
  })

  it('fires every sink on an unexpected socket close (daemon-died recovery)', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const sink: DaemonSessionSink = { onData: vi.fn(), onExit: vi.fn() }
    h.client.registerSink('s1', sink)

    sock.emit('close')
    expect(sink.onExit).toHaveBeenCalledWith(0, undefined)
  })

  it('dispose destroys the socket, does not fire sinks, and rejects later ensureReady', async () => {
    const h = makeClient()
    await connectReady(h)
    const sock = h.sockets[0]

    const sink: DaemonSessionSink = { onData: vi.fn(), onExit: vi.fn() }
    h.client.registerSink('s1', sink)

    h.client.dispose()
    expect(sock.destroyed).toBe(true)
    expect(sink.onExit).not.toHaveBeenCalled()

    await expect(h.client.ensureReady()).rejects.toThrow('disposed')
  })
})
