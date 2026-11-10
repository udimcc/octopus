import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer, MAX_CONTROL_LINE_BYTES, type ControlServer } from './control-server'
import {
  CONTROL_PROTOCOL_VERSION,
  ControlErrorCode,
  type ControlHandler,
  type ControlReply,
  type ControlRequest
} from '../../shared/control-protocol'

let root: string
let sock: string
const servers: ControlServer[] = []
const clients: Socket[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopus-cs-'))
  sock = join(root, 'run', 'control.sock')
})
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy()
  for (const s of servers.splice(0)) await s.close()
  rmSync(root, { recursive: true, force: true })
})

const req = (id: string, method = 'projects.list', params: unknown = {}): string =>
  JSON.stringify({ id, version: CONTROL_PROTOCOL_VERSION, method, params }) + '\n'

const echo: ControlHandler = async (r: ControlRequest) =>
  ({ id: r.id, ok: true, result: { echo: r.id } }) as unknown as ControlReply

async function start(handle: ControlHandler = echo, path = sock): Promise<ControlServer> {
  const s = createControlServer({ socketPath: path, handle })
  servers.push(s)
  await s.listen()
  return s
}

interface Client {
  socket: Socket
  lines: string[]
  closed: Promise<void>
  waitLines(n: number): Promise<ControlReply[]>
}

function dial(path = sock): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    clients.push(socket)
    socket.setEncoding('utf8')
    const lines: string[] = []
    let buf = ''
    const waiters: Array<() => void> = []
    socket.on('data', (c: string) => {
      buf += c
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
      waiters.splice(0).forEach((w) => w())
    })
    let isClosed = false
    const closed = new Promise<void>((r) =>
      socket.on('close', () => {
        isClosed = true
        r()
        waiters.splice(0).forEach((w) => w())
      })
    )
    socket.once('error', reject)
    socket.once('connect', () =>
      resolve({
        socket,
        lines,
        closed,
        async waitLines(n) {
          while (lines.length < n) {
            if (isClosed) throw new Error(`socket closed after ${lines.length}/${n} lines`)
            await new Promise<void>((r) => waiters.push(r))
          }
          return lines.slice(0, n).map((l) => JSON.parse(l) as ControlReply)
        }
      })
    )
  })
}

/** A child process that binds `path` and is then SIGKILLed: leaves a stale socket file. */
async function makeStaleSocket(path: string): Promise<void> {
  mkdirSync(join(path, '..'), { recursive: true })
  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(process.argv[1],()=>console.log('ready'))`, path],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  )
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
      child.once('exit', (code, sig) =>
        reject(new Error(`stale-socket child exited early (code=${code}, signal=${sig})`))
      )
    })
  } catch (e) {
    child.kill('SIGKILL')
    throw e
  }
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill('SIGKILL')
  await exited
}

describe('framing', () => {
  it('answers a request with one reply line carrying the id', async () => {
    await start()
    const c = await dial()
    c.socket.write(req('a'))
    expect(await c.waitLines(1)).toEqual([{ id: 'a', ok: true, result: { echo: 'a' } }])
  })

  it('reassembles a request split across chunks', async () => {
    await start()
    const c = await dial()
    const full = req('split')
    c.socket.write(full.slice(0, 10))
    await new Promise((r) => setTimeout(r, 20))
    c.socket.write(full.slice(10, 30))
    await new Promise((r) => setTimeout(r, 20))
    c.socket.write(full.slice(30))
    const [reply] = await c.waitLines(1)
    expect(reply.id).toBe('split')
  })

  it('serves multiple requests sent in one write on one connection', async () => {
    await start()
    const c = await dial()
    c.socket.write(req('1') + req('2') + req('3'))
    const replies = await c.waitLines(3)
    expect(replies.map((r) => r.id).sort()).toEqual(['1', '2', '3'])
  })

  it('serves concurrent clients independently', async () => {
    await start()
    const cs = await Promise.all(Array.from({ length: 8 }, () => dial()))
    cs.forEach((c, i) => c.socket.write(req(`c${i}`)))
    const all = await Promise.all(cs.map((c) => c.waitLines(1)))
    expect(all.map(([r]) => r.id)).toEqual(cs.map((_, i) => `c${i}`))
  })

  it('ignores blank lines', async () => {
    await start()
    const c = await dial()
    c.socket.write('\n\n  \n' + req('x'))
    expect((await c.waitLines(1))[0].id).toBe('x')
  })

  it('replies bad_json / unknown_method / version_mismatch without calling the handler', async () => {
    let calls = 0
    await start(async (r) => {
      calls++
      return echo(r)
    })
    const c = await dial()
    c.socket.write(
      'garbage\n' +
        req('u', 'nope') +
        JSON.stringify({ id: 'v', version: 99, method: 'projects.list' }) +
        '\n'
    )
    const replies = await c.waitLines(3)
    const codes = replies.map((r) => (r.ok ? 'ok' : r.error.code))
    expect(codes).toEqual([
      ControlErrorCode.BadJson,
      ControlErrorCode.UnknownMethod,
      ControlErrorCode.VersionMismatch
    ])
    expect(calls).toBe(0)
  })

  it('maps a rejecting or throwing handler to an internal error without leaking the message', async () => {
    await start(async (r) => {
      if (r.id === 'throw') throw new Error('secret detail')
      return Promise.reject(new Error('secret detail'))
    })
    const c = await dial()
    c.socket.write(req('throw') + req('reject'))
    const replies = await c.waitLines(2)
    for (const r of replies) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe(ControlErrorCode.Internal)
        expect(r.error.message).not.toContain('secret')
      }
    }
  })

  it('rejects an over-long unterminated line and closes the connection', async () => {
    await start()
    const c = await dial()
    c.socket.write('x'.repeat(MAX_CONTROL_LINE_BYTES + 10))
    const [reply] = await c.waitLines(1)
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe(ControlErrorCode.BadRequest)
    await c.closed
  })

  it('survives a client that vanishes mid-request', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const enteredP = new Promise<void>((r) => (entered = r))
    await start(async (r) => {
      entered()
      await gate
      return echo(r)
    })
    const gone = await dial()
    gone.socket.write(req('gone'))
    await enteredP
    gone.socket.destroy()
    release()
    const c = await dial()
    c.socket.write(req('after'))
    expect((await c.waitLines(1))[0].id).toBe('after')
  })
})

describe('socket and directory permissions', () => {
  it('creates the directory 0700 and the socket 0600', async () => {
    await start()
    expect(statSync(join(root, 'run')).mode & 0o777).toBe(0o700)
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })

  it('tightens a looser pre-existing directory to 0700', async () => {
    mkdirSync(join(root, 'run'), { mode: 0o755 })
    chmodSync(join(root, 'run'), 0o755)
    await start()
    expect(statSync(join(root, 'run')).mode & 0o777).toBe(0o700)
  })
})

describe('stale and live socket handling', () => {
  it('unlinks a stale socket file (nobody listening) and binds', async () => {
    await makeStaleSocket(sock)
    expect(existsSync(sock)).toBe(true)
    await start()
    const c = await dial()
    c.socket.write(req('fresh'))
    expect((await c.waitLines(1))[0].id).toBe('fresh')
  })

  it('does not clobber a live instance: second listen rejects and the first keeps serving', async () => {
    await start()
    const second = createControlServer({ socketPath: sock, handle: echo })
    servers.push(second)
    await expect(second.listen()).rejects.toThrow(/already serving/)
    await second.close() // must not unlink the first server's socket
    expect(existsSync(sock)).toBe(true)
    const c = await dial()
    c.socket.write(req('still'))
    expect((await c.waitLines(1))[0].id).toBe('still')
  })

  it.skipIf(process.getuid?.() === 0)(
    'fails closed on a probe error other than ECONNREFUSED/ENOENT: rejects and leaves the file',
    async () => {
      await makeStaleSocket(sock)
      chmodSync(sock, 0o000) // connect() now fails with EACCES
      const s = createControlServer({ socketPath: sock, handle: echo })
      servers.push(s)
      await expect(s.listen()).rejects.toThrow(/cannot probe control socket/)
      expect(existsSync(sock)).toBe(true)
    }
  )

  it('rejects listening twice on the same instance', async () => {
    const s = await start()
    await expect(s.listen()).rejects.toThrow(/already listening/)
  })
})

describe('close', () => {
  it('replies shutting_down to an in-flight request and drops the late handler result', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const enteredP = new Promise<void>((r) => (entered = r))
    const s = await start(async (r) => {
      entered()
      await gate
      return echo(r)
    })
    const c = await dial()
    c.socket.write(req('slow'))
    await enteredP

    const closing = s.close()
    const [reply] = await c.waitLines(1)
    expect(reply).toMatchObject({ id: 'slow', ok: false })
    if (!reply.ok) expect(reply.error.code).toBe(ControlErrorCode.ShuttingDown)

    release() // late result must not produce a second reply
    await closing
    await c.closed
    expect(c.lines).toHaveLength(1)
    expect(existsSync(sock)).toBe(false)
  })

  it('removes the socket file and refuses new connections', async () => {
    const s = await start()
    await s.close()
    expect(existsSync(sock)).toBe(false)
    await expect(dial()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('listen() after close() does nothing and binds no socket', async () => {
    const s = createControlServer({ socketPath: sock, handle: echo })
    servers.push(s)
    await s.close()
    await expect(s.listen()).resolves.toBeUndefined()
    expect(existsSync(sock)).toBe(false)
  })

  it('close() is idempotent', async () => {
    const s = await start()
    await s.close()
    await expect(s.close()).resolves.toBeUndefined()
  })
})
