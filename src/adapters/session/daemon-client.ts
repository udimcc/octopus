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
 * ## Auto-restart of a stale daemon (§6.2 upgrade path)
 * Because the daemon is DETACHED it survives not just an app restart but a REBUILD:
 * a daemon spawned by a pre-upgrade build keeps holding the socket, and connecting
 * to it would silently run old code (e.g. a v1 daemon that never emits `state`
 * frames → no status icons). So the `hello` handshake compares `PROTOCOL_VERSION`:
 * a COMPATIBLE daemon is adopted as-is; an INCOMPATIBLE one is RETIRED — we SIGTERM
 * it by the pid it reports in `helloAck`, wait for it to release the socket, then
 * launch a fresh daemon. A current daemon is never disturbed.
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

/** A daemon-evaluated state change delivered to a session sink (§9.6). */
export interface DaemonStateUpdate {
  readonly state: 'unknown' | 'waiting' | 'working' | 'blocked'
  readonly layer?: 1 | 2 | 3
  readonly confidence?: 'authoritative' | 'high' | 'medium' | 'low' | 'none'
  readonly reason?: string
  readonly subState?: string
}

/** Per-session event sink; wired by a {@link DaemonSessionRuntime}. */
export interface DaemonSessionSink {
  /** A batched output chunk (live or replayed-on-attach). */
  onData(data: string): void
  /** SPONTANEOUS death (or a daemon-crash synthetic exit); never fired for a `close`. */
  onExit(exitCode: number, signal?: number): void
  /**
   * An evaluated state change pushed by the daemon (§9.6), including the state
   * replayed on (re-)attach. Optional: a runtime with detection disabled omits it.
   */
  onState?(update: DaemonStateUpdate): void
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
  /**
   * Injectable for tests: retire an incompatible daemon by pid (SIGTERM). Returns
   * false if the signal could not be sent. Used to auto-restart a stale pre-upgrade
   * daemon on a protocol mismatch (§6.2).
   */
  readonly killFn?: (pid: number) => boolean
  /**
   * Injectable for tests: is `pid` still alive? Polled after `killFn` so we relaunch
   * only once the stale daemon has actually released the socket.
   */
  readonly isAliveFn?: (pid: number) => boolean
  /** Injectable timers (tests drive backoff without real time). */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
}

interface Pending {
  resolve(msg: DaemonMessage): void
  reject(err: Error): void
}

/**
 * Result of the `hello` handshake. `ok` ⇒ a compatible daemon we can adopt. Else the
 * daemon is incompatible (or the reply was malformed): `reason` explains it and `pid`
 * — present only when the peer reported one — lets us retire a stale daemon (§6.2).
 */
type HandshakeOutcome = { ok: true } | { ok: false; reason: string; pid?: number }

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
  private readonly killFn: (pid: number) => boolean
  private readonly isAliveFn: (pid: number) => boolean
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
    this.killFn = opts.killFn ?? ((pid) => defaultKill(pid))
    this.isAliveFn = opts.isAliveFn ?? ((pid) => defaultIsAlive(pid))
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

  /** Ask the daemon to re-evaluate a session's state now (§9.6); reply via onState. */
  refreshState(sessionId: string): void {
    this.sendControl({ type: 'refreshState', sessionId })
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
    this.teardownSocket()
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private async connectOrLaunch(): Promise<void> {
    // 1. A daemon may already be running (durability across app restart). If it is,
    //    handshake it: a COMPATIBLE daemon is adopted as-is; an INCOMPATIBLE one
    //    (stale, pre-upgrade — §6.2) is retired here so we can launch a fresh one.
    if (await this.tryConnectOnce()) {
      const outcome = await this.handshake()
      if (outcome.ok) {
        return
      }
      // A stale daemon still owns the socket. Retire it by pid and wait for it to
      // release the socket, else the fresh daemon's singleton probe would see a live
      // peer and back off (leaving us stuck on the old one). Without a pid we can't
      // retire it — surface the mismatch so the caller degrades to in-process.
      if (outcome.pid === undefined || !(await this.retireStaleDaemon(outcome.pid))) {
        throw new Error(outcome.reason)
      }
    }
    // 2. No daemon answered (or we just retired an incompatible one) — launch a fresh
    //    one, then retry connect + handshake with backoff.
    if (!this.launchFn()) {
      throw new Error('failed to launch octopusd')
    }
    const deadline = this.connectTimeoutMs
    let waited = 0
    while (waited < deadline) {
      await this.delay(this.connectRetryMs)
      waited += this.connectRetryMs
      if (await this.tryConnectOnce()) {
        const outcome = await this.handshake()
        if (outcome.ok) {
          return
        }
        // A freshly-launched daemon should match; a mismatch here means something is
        // badly wrong (wrong binary on the path). Don't loop killing it — give up.
        throw new Error(outcome.reason)
      }
    }
    throw new Error('octopusd launched but never became reachable')
  }

  /**
   * Run `hello` on the just-connected socket. On success the socket is KEPT — it is
   * the live connection the client will use. On any failure (incompatible daemon, or
   * a malformed reply) the socket is torn down so the caller can relaunch/retire
   * cleanly and a later `ensureReady()` won't short-circuit on a half-dead socket.
   * Returns a discriminated outcome instead of throwing so `connectOrLaunch` can
   * branch on compatibility (§6.2).
   */
  private async handshake(): Promise<HandshakeOutcome> {
    let outcome: HandshakeOutcome
    try {
      outcome = await this.hello()
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (!outcome.ok) {
      this.teardownSocket()
    }
    return outcome
  }

  /**
   * Retire a stale/incompatible daemon (§6.2): SIGTERM it, then poll until the
   * process is gone (bounded by `connectTimeoutMs`) so the fresh daemon can bind the
   * socket. Returns true once it's confirmed dead, false if we couldn't signal it or
   * it outlived the wait (→ caller degrades to in-process rather than fighting it).
   */
  private async retireStaleDaemon(pid: number): Promise<boolean> {
    if (!this.killFn(pid)) {
      return false
    }
    const deadline = this.connectTimeoutMs
    let waited = 0
    while (waited < deadline) {
      if (!this.isAliveFn(pid)) {
        return true
      }
      await this.delay(this.connectRetryMs)
      waited += this.connectRetryMs
    }
    return !this.isAliveFn(pid)
  }

  /** Detach listeners and destroy the current socket, if any. */
  private teardownSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
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

  /**
   * Send `hello` and classify the reply. A protocol mismatch is NOT thrown — it is
   * an expected condition after an upgrade (a stale daemon still holds the socket),
   * so it returns `{ok:false, pid}` and lets `connectOrLaunch` retire + relaunch. A
   * malformed/absent reply is a hard error (no pid ⇒ can't retire ⇒ degrade).
   */
  private async hello(): Promise<HandshakeOutcome> {
    const reply = await this.request((requestId) => ({
      type: 'hello',
      requestId,
      protocolVersion: PROTOCOL_VERSION
    }))
    if (reply.type !== 'helloAck') {
      return { ok: false, reason: `unexpected hello reply: ${reply.type}` }
    }
    if (reply.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `daemon protocol ${reply.protocolVersion} != client ${PROTOCOL_VERSION}`,
        pid: reply.pid
      }
    }
    return { ok: true }
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
    // Spontaneous exit is one unsolicited control message (no requestId).
    if (msg.type === 'exit') {
      const sink = this.sinks.get(msg.sessionId)
      this.sinks.delete(msg.sessionId)
      sink?.onExit(msg.exitCode, msg.signal)
      return
    }
    // An evaluated state change is the other unsolicited message (§9.6). Keep the
    // sink registered — a session emits many state frames over its lifetime.
    if (msg.type === 'state') {
      this.sinks.get(msg.sessionId)?.onState?.({
        state: msg.state,
        layer: msg.layer,
        confidence: msg.confidence,
        reason: msg.reason,
        subState: msg.subState
      })
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

/**
 * Default retire: SIGTERM the daemon by pid (§6.2). The daemon installs a SIGTERM
 * handler that closes its server and exits, releasing the control socket. Returns
 * false if the signal can't be sent (already gone, or not permitted).
 */
function defaultKill(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/** Default liveness probe: signal 0 tests existence without delivering a signal. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH ⇒ the process is gone. EPERM ⇒ it exists but we may not signal it (it is
    // OUR own daemon, same uid, so this is not expected — treat as still alive so we
    // don't relaunch into a socket the old daemon still holds).
    return (err as { code?: string }).code === 'EPERM'
  }
}
