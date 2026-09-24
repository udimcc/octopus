/**
 * The daemon's Unix-socket control server (DESIGN §6.2). Accepts client
 * connections, reassembles frames ({@link FrameDecoder}), dispatches control
 * messages against the {@link PtyRegistry}, and streams a session's batched output
 * / exit back to whichever connection is currently attached to it.
 *
 * ## One attached client per session
 * A session streams to AT MOST ONE connection at a time (the app). `attach` points
 * the session's sink at that connection; a new attach (e.g. after an app restart
 * re-connects) replaces it and replays the ring buffer. A connection dropping
 * detaches every session it held — the PTYs keep running (that is the durability
 * guarantee, §6.2).
 *
 * ## Security
 * The control socket lives in `/tmp/octopus-<uid>/` at mode 0700, so only the
 * owning uid can connect — the capability gate (§9.2), same as the state sockets.
 * A defence-in-depth `SO_PEERCRED` peer-uid check would need a native binding
 * (Node exposes no API); the 0700 dir is the enforced boundary in this phase.
 *
 * Pure of node-pty: it drives the injected {@link PtyRegistry}, so the dispatch
 * logic is unit-testable without spawning shells.
 */

import { createServer, type Server, type Socket } from 'node:net'
import {
  FrameDecoder,
  encodeControl,
  encodeData,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage
} from '../shared/node/daemon-protocol'
import type { PtyRegistry } from './pty-registry'

export interface DaemonServerOptions {
  readonly registry: PtyRegistry
  readonly socketPath: string
  readonly daemonVersion: string
  /** Called after a client message is handled — lets the daemon re-evaluate its idle/exit policy. */
  readonly onActivity?: () => void
  /** Called when a session is fully closed or reaped, so lifecycle can react. */
  readonly onSessionGone?: (sessionId: string) => void
}

/** A live connection + its decoder + the set of sessions it is attached to. */
interface Conn {
  readonly socket: Socket
  readonly decoder: FrameDecoder
  readonly attached: Set<string>
}

export class DaemonServer {
  private readonly registry: PtyRegistry
  private readonly socketPath: string
  private readonly daemonVersion: string
  private readonly onActivity?: () => void
  private readonly onSessionGone?: (sessionId: string) => void
  private readonly server: Server
  private readonly conns = new Set<Conn>()

  constructor(opts: DaemonServerOptions) {
    this.registry = opts.registry
    this.socketPath = opts.socketPath
    this.daemonVersion = opts.daemonVersion
    this.onActivity = opts.onActivity
    this.onSessionGone = opts.onSessionGone
    this.server = createServer((socket) => this.onConnection(socket))
  }

  /** Bind the socket. Rejects if the path is already in use (singleton conflict). */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /** Number of currently-connected clients (for the idle/exit policy). */
  get clientCount(): number {
    return this.conns.size
  }

  close(): Promise<void> {
    for (const conn of this.conns) {
      conn.socket.destroy()
    }
    this.conns.clear()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private onConnection(socket: Socket): void {
    const conn: Conn = { socket, decoder: new FrameDecoder(), attached: new Set() }
    this.conns.add(conn)
    socket.on('data', (chunk) => this.onData(conn, chunk))
    socket.on('error', () => this.dropConn(conn))
    socket.on('close', () => this.dropConn(conn))
  }

  private dropConn(conn: Conn): void {
    if (!this.conns.has(conn)) {
      return
    }
    this.conns.delete(conn)
    // Detach (do NOT close) every session this client was viewing — PTYs live on.
    for (const sessionId of conn.attached) {
      this.registry.get(sessionId)?.detach()
    }
    conn.attached.clear()
    this.onActivity?.()
  }

  private onData(conn: Conn, chunk: Buffer): void {
    let frames
    try {
      frames = conn.decoder.push(chunk)
    } catch {
      // Corrupt/hostile stream — sever this connection.
      conn.socket.destroy()
      this.dropConn(conn)
      return
    }
    for (const frame of frames) {
      if (frame.kind === 'data') {
        // A DATA frame from a client is a keystroke `write`.
        this.registry.get(frame.sessionId)?.write(frame.data)
      } else {
        this.handleControl(conn, frame.message as ClientMessage)
      }
    }
    this.onActivity?.()
  }

  private send(conn: Conn, message: DaemonMessage): void {
    conn.socket.write(encodeControl(message))
  }

  private handleControl(conn: Conn, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello':
        this.send(conn, {
          type: 'helloAck',
          requestId: msg.requestId,
          protocolVersion: PROTOCOL_VERSION,
          daemonVersion: this.daemonVersion,
          // Our own pid so an app on a protocol mismatch can retire us (§6.2): a
          // stale pre-upgrade daemon must be killed before a fresh one can bind.
          pid: process.pid
        })
        return

      case 'listSessions':
        this.send(conn, {
          type: 'sessions',
          requestId: msg.requestId,
          sessions: this.registry.list()
        })
        return

      case 'spawn': {
        try {
          const dpty = this.registry.spawnSession(msg.params)
          const sessionId = msg.params.sessionId
          this.bindSink(conn, sessionId)
          this.send(conn, { type: 'spawned', requestId: msg.requestId, sessionId, pid: dpty.pid })
        } catch (err) {
          this.send(conn, {
            type: 'spawnError',
            requestId: msg.requestId,
            sessionId: msg.params.sessionId,
            message: err instanceof Error ? err.message : String(err)
          })
        }
        return
      }

      case 'attach': {
        // A re-attach adopts a program that configured a terminal which no longer
        // exists, so its sticky modes are re-asserted after the replay (§6.2).
        const alive = this.bindSink(conn, msg.sessionId, { restoreModes: true })
        this.send(conn, {
          type: 'attached',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          alive: alive ?? false
        })
        return
      }

      case 'detach':
        conn.attached.delete(msg.sessionId)
        this.registry.get(msg.sessionId)?.detach()
        return

      case 'resize':
        this.registry.get(msg.sessionId)?.resize(msg.cols, msg.rows)
        return

      case 'close': {
        const sessionId = msg.sessionId
        void this.registry.close(sessionId).then(() => {
          conn.attached.delete(sessionId)
          this.send(conn, { type: 'closed', requestId: msg.requestId, sessionId })
          this.onSessionGone?.(sessionId)
          this.onActivity?.()
        })
        return
      }

      case 'shutdown': {
        // Honored only when no live PTYs remain (lifecycle owns the actual exit).
        const accepted = this.registry.size === 0
        this.send(conn, { type: 'shutdownAck', requestId: msg.requestId, accepted })
        return
      }
    }
  }

  /**
   * Point a session's output/exit at this connection and record the attachment.
   * Returns whether the session exists + is alive (undefined = no such session).
   */
  private bindSink(
    conn: Conn,
    sessionId: string,
    opts?: { readonly restoreModes?: boolean }
  ): boolean | undefined {
    const dpty = this.registry.get(sessionId)
    if (!dpty) {
      return undefined
    }
    conn.attached.add(sessionId)
    return dpty.attach(
      {
        onData: (data) => conn.socket.write(encodeData(sessionId, data)),
        onExit: (exitCode, signal) => {
          conn.attached.delete(sessionId)
          this.send(conn, { type: 'exit', sessionId, exitCode, signal })
          this.registry.forget(sessionId)
          this.onSessionGone?.(sessionId)
          this.onActivity?.()
        }
      },
      opts
    )
  }
}
