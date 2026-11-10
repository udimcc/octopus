/**
 * Control-socket server (framing only). Accepts NDJSON requests over a Unix socket,
 * parses them with `parseControlRequest`, and delegates to a `ControlHandler`.
 *
 * `src/daemon/singleton-lock.ts` cannot be imported here (adapters may not import
 * `daemon`), so the small probe-then-unlink stale-socket logic is mirrored below.
 */

import { createServer, connect, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ControlErrorCode,
  controlError,
  parseControlRequest,
  type ControlHandler,
  type ControlReply
} from '../../shared/control-protocol'

/** Longest accepted request line (bytes of buffered, unterminated data). */
export const MAX_CONTROL_LINE_BYTES = 1024 * 1024

export interface ControlServerLogger {
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface ControlServerOptions {
  readonly socketPath: string
  readonly handle: ControlHandler
  readonly logger?: ControlServerLogger
}

export interface ControlServer {
  /**
   * Bind the socket (dir 0700, socket 0600). Rejects if a live server already owns
   * the path (that socket is left untouched) or on any other bind error.
   */
  listen(): Promise<void>
  /**
   * Stop accepting, immediately reply `shutting_down` to in-flight requests (their
   * later handler results are dropped), destroy connections, unlink the socket file.
   */
  close(): Promise<void>
}

export function createControlServer(opts: ControlServerOptions): ControlServer {
  const { socketPath, handle, logger } = opts
  const sockets = new Set<Socket>()
  /** In-flight requests: id-keyed per socket so close() can answer them. */
  const inflight = new Map<Socket, Set<{ id: string; settled: boolean }>>()
  let server: Server | undefined
  let closing = false

  function write(socket: Socket, reply: ControlReply): void {
    if (socket.destroyed || !socket.writable) return
    socket.write(JSON.stringify(reply) + '\n')
  }

  function dispatch(socket: Socket, line: string): void {
    if (closing) return
    const parsed = parseControlRequest(line)
    if (!parsed.ok) {
      write(socket, controlError(parsed.id, parsed.error.code, parsed.error.message))
      return
    }
    const { request } = parsed
    const entry = { id: request.id, settled: false }
    inflight.get(socket)?.add(entry)
    const finish = (reply: ControlReply): void => {
      if (entry.settled) return
      entry.settled = true
      inflight.get(socket)?.delete(entry)
      write(socket, reply)
    }
    let pending: Promise<ControlReply>
    try {
      pending = handle(request)
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.then(finish, (err: unknown) => {
      logger?.error(`control handler for ${request.method} threw`, err)
      finish(controlError(request.id, ControlErrorCode.Internal, 'internal error'))
    })
  }

  function onConnection(socket: Socket): void {
    if (closing) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    inflight.set(socket, new Set())
    socket.setEncoding('utf8')
    socket.on('error', () => {
      // EPIPE / ECONNRESET from vanished clients: nothing to do.
    })
    socket.on('close', () => {
      sockets.delete(socket)
      inflight.delete(socket)
    })

    let buf = ''
    let rejected = false
    socket.on('data', (chunk: string) => {
      if (rejected || closing) return
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.length > 0) dispatch(socket, line)
        if (closing) return
        nl = buf.indexOf('\n')
      }
      if (Buffer.byteLength(buf, 'utf8') > MAX_CONTROL_LINE_BYTES) {
        buf = ''
        rejected = true
        socket.end(
          JSON.stringify(controlError('', ControlErrorCode.BadRequest, 'request line too long')) +
            '\n'
        )
        socket.destroySoon()
      }
    })
  }

  function prepareDir(): void {
    const dir = dirname(socketPath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mkdir's mode is ignored for an existing dir (and masked by umask): enforce.
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
  }

  function bind(srv: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      srv.once('error', onError)
      srv.listen(socketPath, () => {
        srv.off('error', onError)
        resolve()
      })
    })
  }

  return {
    async listen(): Promise<void> {
      if (closing) return // quit began before the (post-warmup) listen: never bind
      if (server) throw new Error('control server already listening')
      prepareDir()
      if (existsSync(socketPath)) {
        if (await isLive(socketPath)) {
          throw new Error(`another Octopus instance is already serving ${socketPath}`)
        }
        unlinkSync(socketPath) // stale file from a crashed run
      }
      if (closing) return
      const srv = createServer(onConnection)
      await bind(srv)
      if (closing) {
        srv.close()
        try {
          unlinkSync(socketPath)
        } catch {
          // already gone
        }
        return
      }
      try {
        chmodSync(socketPath, 0o600)
      } catch (err) {
        srv.close()
        throw err
      }
      srv.on('error', (err) => logger?.error('control server error', err))
      server = srv
    },

    async close(): Promise<void> {
      closing = true
      const srv = server
      server = undefined
      for (const [socket, entries] of inflight) {
        for (const e of entries) {
          if (e.settled) continue
          e.settled = true
          write(
            socket,
            controlError(
              e.id,
              ControlErrorCode.ShuttingDown,
              'Octopus is shutting down; the command may still complete'
            )
          )
        }
        entries.clear()
      }
      for (const socket of sockets) socket.destroySoon()
      // destroySoon flushes the replies; force-close anything still open afterwards.
      const closed = srv
        ? new Promise<void>((resolve) => srv.close(() => resolve()))
        : Promise.resolve()
      setImmediate(() => {
        for (const socket of sockets) socket.destroy()
      })
      await closed
      if (srv) {
        try {
          unlinkSync(socketPath)
        } catch {
          // already gone
        }
      }
    }
  }
}

/**
 * Is `path` safe to treat as stale? Resolves true (live) on connect; false ONLY for
 * ECONNREFUSED/ENOENT (nobody listening). Any other outcome (timeout, EACCES, …) rejects
 * so the caller fails closed and never unlinks a possibly-live server's socket.
 */
function isLive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const sock = connect(path)
    const done = (answer: boolean | Error): void => {
      sock.destroy()
      if (typeof answer === 'boolean') resolve(answer)
      else reject(answer)
    }
    sock.once('connect', () => done(true))
    sock.once('error', (err: NodeJS.ErrnoException) =>
      done(
        err.code === 'ECONNREFUSED' || err.code === 'ENOENT'
          ? false
          : new Error(`cannot probe control socket ${path}: ${err.code ?? err.message}`)
      )
    )
    sock.setTimeout(timeoutMs, () =>
      done(new Error(`control socket ${path} did not answer the liveness probe`))
    )
  })
}
