/**
 * The app's single long-lived connection to `octopusd` (DESIGN §6.2). One client
 * per app process multiplexes EVERY session over one Unix socket: it owns the
 * framing codec, request/reply correlation, and the fan-out of a session's
 * `data`/`exit` events to the per-session sink registered by its
 * {@link DaemonSessionRuntime}.
 *
 * ## Connect-or-launch (the durability entry point)
 * `ensureReady()` first tries to CONNECT — a daemon left running by a previous app
 * instance is exactly what carries live shells across a restart. Only if no daemon
 * answers does it LAUNCH one (detached, on the bundled Electron binary via
 * `ELECTRON_RUN_AS_NODE=1`, mirroring `scripts/probe-sqlite`), then retries the
 * connect with backoff. If the launch ITSELF fails it rejects, and the caller
 * degrades to the in-process backend for this run (the user-chosen fallback).
 *
 * ## Sinks and ordering
 * A runtime registers its sink BEFORE it issues `spawn`/`attach`, because the
 * daemon writes the replayed ring-buffer `data` frame onto the socket *before* the
 * `attached` reply (`server.ts` binds the sink synchronously inside `attach`). If
 * the sink weren't already registered, that first replay chunk would be dropped.
 *
 * ## Unexpected disconnect
 * A clean app quit calls `dispose()` (intentional; sinks are NOT notified — the
 * daemon keeps the PTYs). An UNEXPECTED socket close means the daemon died, which
 * kills its child PTYs, so every registered sink is fired with a synthetic exit
 * (drives `markExited`) and pending requests reject — the next `ensureReady()`
 * relaunches and callers fall into the fresh-spawn path (§6.2 durability is against
 * APP restart, not daemon crash).
 *
 * Lives in `adapters` (not `daemon`): it is the main-side half of the protocol and
 * may import the `shared` codec, never `src/daemon/**`.
 */

import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import {
  FrameDecoder,
  encodeControl,
  encodeData,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
  type DaemonSessionInfo,
  type SpawnParams
} from '../../shared/node/daemon-protocol'

/** Per-session event sink; wired by a {@link DaemonSessionRuntime}. */
export interface DaemonSessionSink {
  /** A batched output chunk (live or replayed-on-attach). */
  onData(data: string): void
  /** SPONTANEOUS death (or a daemon-crash synthetic exit); never fired for a `close`. */
  onExit(exitCode: number, signal?: number): void
}

export interface DaemonClientOptions {
  /** Control-socket path (`controlSocketPath(uid)`). */
  readonly socketPath: string
  /** Absolute path to the built `daemon.js` (out/main/daemon.js). */
  readonly daemonEntry: string
  /** Binary to launch the daemon with (default: the bundled Electron via execPath). */
  readonly execPath?: string
  /** Version string handed to the daemon (surfaced in `helloAck`). */
  readonly daemonVersion?: string
  /** Total time to keep retrying connect after a launch before giving up (ms). */
  readonly connectTimeoutMs?: number
  /** Delay between connect retries while waiting for a freshly-launched daemon (ms). */
  readonly connectRetryMs?: number
  /** Injectable for tests: perform one connection attempt. */
  readonly connectFn?: (socketPath: string) => Socket
  /** Injectable for tests: launch the daemon process. Returns false if launch failed. */
  readonly launchFn?: () => boolean
  /** Injectable timers (tests drive backoff without real time). */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
}

interface Pending {
  resolve(msg: DaemonMessage): void
  reject(err: Error): void
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000
const DEFAULT_CONNECT_RETRY_MS = 100

export class DaemonClient {
  private readonly socketPath: string
  private readonly daemonEntry: string
  private readonly execPath: string
  private readonly daemonVersion: string
  private readonly connectTimeoutMs: number
  private readonly connectRetryMs: number
  private readonly connectFn: (socketPath: string) => Socket
  private readonly launchFn: () => boolean
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void

  private socket: Socket | null = null
  private decoder = new FrameDecoder()
  private readyPromise: Promise<void> | null = null
  private disposed = false
  private nextRequestId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly sinks = new Map<string, DaemonSessionSink>()

  constructor(opts: DaemonClientOptions) {
    this.socketPath = opts.socketPath
    this.daemonEntry = opts.daemonEntry
    this.execPath = opts.execPath ?? process.execPath
    this.daemonVersion = opts.daemonVersion ?? '0.0.0'
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.connectRetryMs = opts.connectRetryMs ?? DEFAULT_CONNECT_RETRY_MS
    this.connectFn = opts.connectFn ?? ((p) => connect(p))
    this.launchFn = opts.launchFn ?? (() => this.defaultLaunch())
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /**
   * Ensure a connected, hello-acked daemon. Idempotent + coalesced: concurrent
   * callers share one in-flight attempt. Rejects only if the daemon can be neither
   * reached nor launched (→ caller degrades to in-process).
   */
  ensureReady(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('daemon client disposed'))
    }
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve()
    }
    if (!this.readyPromise) {
      this.readyPromise = this.connectOrLaunch().finally(() => {
        this.readyPromise = null
      })
    }
    return this.readyPromise
  }

  /** Register a session's sink; MUST be called before `spawn`/`attach` (see docblock). */
  registerSink(sessionId: string, sink: DaemonSessionSink): void {
    this.sinks.set(sessionId, sink)
  }

  unregisterSink(sessionId: string): void {
    this.sinks.delete(sessionId)
  }

  /** The re-attach roster (§6.2). */
  async listSessions(): Promise<readonly DaemonSessionInfo[]> {
    const reply = await this.request((requestId) => ({ type: 'listSessions', requestId }))
    return reply.type === 'sessions' ? reply.sessions : []
  }

  /** Spawn a fresh PTY; resolves with its pid. Rejects on `spawnError`. */
  async spawn(params: SpawnParams): Promise<number> {
    const reply = await this.request((requestId) => ({ type: 'spawn', requestId, params }))
    if (reply.type === 'spawnError') {
      throw new Error(reply.message)
    }
    if (reply.type !== 'spawned') {
      throw new Error(`unexpected reply to spawn: ${reply.type}`)
    }
    return reply.pid
  }

  /** Re-attach to a live PTY; resolves with whether it is still alive. */
  async attach(sessionId: string): Promise<boolean> {
    const reply = await this.request((requestId) => ({ type: 'attach', requestId, sessionId }))
    return reply.type === 'attached' ? reply.alive : false
  }

  /** Stop viewing a session without killing it (the PTY keeps running, §6.2). */
  detach(sessionId: string): void {
    this.sendControl({ type: 'detach', sessionId })
  }

  write(sessionId: string, data: string): void {
    // Hot path: raw bytes as a DATA frame (no base64 inflation, §6.2).
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(encodeData(sessionId, data))
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sendControl({ type: 'resize', sessionId, cols, rows })
  }

  /** Graceful close (SIGHUP→grace→SIGKILL daemon-side); resolves on `closed`. */
  async close(sessionId: string): Promise<void> {
    await this.request((requestId) => ({ type: 'close', requestId, sessionId }))
  }

  /**
   * Drop the connection WITHOUT killing PTYs (the daemon treats a disconnect as
   * detach-all). Intentional: sinks are not notified. Used on a clean app quit.
   */
  dispose(): void {
    this.disposed = true
    this.rejectAllPending(new Error('daemon client disposed'))
    this.sinks.clear()
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private async connectOrLaunch(): Promise<void> {
    // 1. A daemon may already be running (durability across app restart).
    if (await this.tryConnectOnce()) {
      await this.hello()
      return
    }
    // 2. None answered — launch one, then retry connect with backoff.
    if (!this.launchFn()) {
      throw new Error('failed to launch octopusd')
    }
    const deadline = this.connectTimeoutMs
    let waited = 0
    while (waited < deadline) {
      await this.delay(this.connectRetryMs)
      waited += this.connectRetryMs
      if (await this.tryConnectOnce()) {
        await this.hello()
        return
      }
    }
    throw new Error('octopusd launched but never became reachable')
  }

  /** One connect attempt. Resolves true on success (socket wired), false on failure. */
  private tryConnectOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = this.connectFn(this.socketPath)
      const onError = (): void => {
        sock.removeListener('connect', onConnect)
        sock.destroy()
        resolve(false)
      }
      const onConnect = (): void => {
        sock.removeListener('error', onError)
        this.wireSocket(sock)
        resolve(true)
      }
      sock.once('error', onError)
      sock.once('connect', onConnect)
    })
  }

  private wireSocket(sock: Socket): void {
    this.socket = sock
    this.decoder = new FrameDecoder()
    sock.on('data', (chunk) => this.onData(chunk))
    sock.on('close', () => this.onSocketClose())
    sock.on('error', () => {
      // 'close' follows; handle teardown there.
    })
  }

  private onSocketClose(): void {
    if (this.disposed) {
      return
    }
    const dead = this.socket
    this.socket = null
    if (dead) {
      dead.removeAllListeners()
    }
    // The daemon died → its child PTYs died with it. Notify every sink so the
    // command loop marks each session exited, then let callers relaunch + respawn.
    this.rejectAllPending(new Error('daemon connection lost'))
    const sinks = [...this.sinks.values()]
    this.sinks.clear()
    for (const sink of sinks) {
      sink.onExit(0, undefined)
    }
  }

  private async hello(): Promise<void> {
    const reply = await this.request((requestId) => ({
      type: 'hello',
      requestId,
      protocolVersion: PROTOCOL_VERSION
    }))
    if (reply.type !== 'helloAck') {
      throw new Error(`unexpected hello reply: ${reply.type}`)
    }
    if (reply.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `daemon protocol ${reply.protocolVersion} != client ${PROTOCOL_VERSION}`
      )
    }
  }

  // -------------------------------------------------------------------------
  // Framing / dispatch
  // -------------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    let frames
    try {
      frames = this.decoder.push(chunk)
    } catch {
      // Corrupt stream — sever and let onSocketClose drive recovery.
      this.socket?.destroy()
      return
    }
    for (const frame of frames) {
      if (frame.kind === 'data') {
        this.sinks.get(frame.sessionId)?.onData(frame.data)
      } else {
        this.dispatchControl(frame.message as DaemonMessage)
      }
    }
  }

  private dispatchControl(msg: DaemonMessage): void {
    // Spontaneous exit is the one unsolicited control message (no requestId).
    if (msg.type === 'exit') {
      const sink = this.sinks.get(msg.sessionId)
      this.sinks.delete(msg.sessionId)
      sink?.onExit(msg.exitCode, msg.signal)
      return
    }
    const pending = this.pending.get(msg.requestId)
    if (pending) {
      this.pending.delete(msg.requestId)
      pending.resolve(msg)
    }
  }

  /** Send a control message that expects a correlated reply. */
  private request(build: (requestId: number) => ClientMessage): Promise<DaemonMessage> {
    return new Promise<DaemonMessage>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('daemon not connected'))
        return
      }
      const requestId = this.nextRequestId++
      this.pending.set(requestId, { resolve, reject })
      this.socket.write(encodeControl(build(requestId)))
    })
  }

  /** Send a fire-and-forget control message (no reply expected). */
  private sendControl(msg: ClientMessage): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(encodeControl(msg))
    }
  }

  private rejectAllPending(err: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) {
      p.reject(err)
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimer(() => resolve(), ms)
    })
  }

  /** Default launch: run the bundled Electron binary as Node, detached (§6.2). */
  private defaultLaunch(): boolean {
    try {
      const child = spawn(this.execPath, [this.daemonEntry], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          OCTOPUS_DAEMON_VERSION: this.daemonVersion
        },
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      return true
    } catch {
      return false
    }
  }
}
