import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXIT_COMMAND_ERROR,
  EXIT_NOT_RUNNING,
  EXIT_OK,
  EXIT_USAGE,
  buildRequest,
  failureToOutcome,
  parseReplyLine,
  replyToOutcome,
  sendRequest,
  usageToOutcome
} from './client'
import { CONTROL_PROTOCOL_VERSION, type ControlReply } from '../shared/control-protocol'

describe('exit codes', () => {
  it('are 0/1/2/3', () => {
    expect([EXIT_OK, EXIT_COMMAND_ERROR, EXIT_USAGE, EXIT_NOT_RUNNING]).toEqual([0, 1, 2, 3])
  })
})

describe('buildRequest', () => {
  it('builds a versioned envelope with a unique id by default', () => {
    const a = buildRequest('task.list', { project: 'p' })
    const b = buildRequest('task.list', {})
    expect(a).toMatchObject({
      version: CONTROL_PROTOCOL_VERSION,
      method: 'task.list',
      params: { project: 'p' }
    })
    expect(a.id).not.toBe(b.id)
    expect(buildRequest('projects.list', {}, 'fixed').id).toBe('fixed')
  })
})

describe('replyToOutcome', () => {
  it('success: result JSON compact on stdout, exit 0', () => {
    const o = replyToOutcome({ id: 'a', ok: true, result: { taskId: 't1' } } as ControlReply)
    expect(o).toEqual({ exitCode: 0, stdout: '{"taskId":"t1"}\n', stderr: '' })
    expect(() => JSON.parse(o.stdout)).not.toThrow()
  })

  it('failure: error JSON on stderr, exit 1, nothing on stdout', () => {
    const o = replyToOutcome({
      id: 'a',
      ok: false,
      error: { code: 'not_found', message: 'unknown project "x"' }
    })
    expect(o.exitCode).toBe(1)
    expect(o.stdout).toBe('')
    expect(JSON.parse(o.stderr)).toEqual({
      error: { code: 'not_found', message: 'unknown project "x"' }
    })
  })
})

describe('failureToOutcome', () => {
  it('not_running: exit 3 with "Octopus is not running" and the socket path', () => {
    const o = failureToOutcome({ kind: 'not_running', socketPath: '/s/control.sock' })
    expect(o.exitCode).toBe(3)
    const e = JSON.parse(o.stderr).error
    expect(e.code).toBe('not_running')
    expect(e.message).toContain('Octopus is not running')
    expect(e.message).toContain('/s/control.sock')
  })

  it('closed and io: exit 1', () => {
    expect(failureToOutcome({ kind: 'closed' }).exitCode).toBe(1)
    const o = failureToOutcome({ kind: 'io', message: 'bad' })
    expect(o.exitCode).toBe(1)
    expect(JSON.parse(o.stderr).error).toEqual({ code: 'io_error', message: 'bad' })
  })
})

describe('usageToOutcome', () => {
  it('exit 2, message on stderr with exactly one trailing newline', () => {
    expect(usageToOutcome('oops\n\n')).toEqual({ exitCode: 2, stdout: '', stderr: 'oops\n' })
    expect(usageToOutcome('oops').stderr).toBe('oops\n')
  })
})

describe('parseReplyLine', () => {
  it('accepts ok and error replies for the matching id', () => {
    expect(parseReplyLine('{"id":"a","ok":true,"result":{}}', 'a')).toBeDefined()
    expect(
      parseReplyLine('{"id":"a","ok":false,"error":{"code":"x","message":"m"}}', 'a')
    ).toBeDefined()
  })

  it('accepts an id-less failure (server could not recover the id)', () => {
    expect(
      parseReplyLine('{"id":"","ok":false,"error":{"code":"bad_json","message":"m"}}', 'a')
    ).toBeDefined()
  })

  it('rejects a mismatched id, malformed JSON, and shapeless objects', () => {
    expect(parseReplyLine('{"id":"b","ok":true,"result":{}}', 'a')).toBeUndefined()
    expect(parseReplyLine('{"id":"","ok":true,"result":{}}', 'a')).toBeUndefined()
    expect(parseReplyLine('not json', 'a')).toBeUndefined()
    expect(parseReplyLine('null', 'a')).toBeUndefined()
    expect(parseReplyLine('{"id":"a","ok":true}', 'a')).toBeUndefined()
    expect(parseReplyLine('{"id":"a","ok":false,"error":null}', 'a')).toBeUndefined()
  })
})

describe('sendRequest', () => {
  let dir: string
  let server: Server | undefined
  const sockets: Socket[] = []

  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.destroy())
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function serve(onLine: (line: string, s: Socket) => void): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), 'octopus-cli-'))
    const path = join(dir, 's.sock')
    server = createServer((s) => {
      sockets.push(s)
      let buf = ''
      s.on('data', (c) => {
        buf += c.toString()
        const i = buf.indexOf('\n')
        if (i >= 0) onLine(buf.slice(0, i), s)
      })
      s.on('error', () => undefined)
    })
    await new Promise<void>((r) => server!.listen(path, r))
    return path
  }

  it('returns the reply for the request id', async () => {
    const path = await serve((line, s) => {
      const req = JSON.parse(line)
      s.write(JSON.stringify({ id: req.id, ok: true, result: { method: req.method } }) + '\n')
    })
    const res = await sendRequest(path, buildRequest('projects.list', {}, 'q1'))
    expect(res).toEqual({ reply: { id: 'q1', ok: true, result: { method: 'projects.list' } } })
  })

  it('ENOENT (no socket file) maps to not_running', async () => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-cli-'))
    const path = join(dir, 'missing.sock')
    expect(await sendRequest(path, buildRequest('projects.list', {}))).toEqual({
      failure: { kind: 'not_running', socketPath: path }
    })
  })

  it('ECONNREFUSED (stale socket file) maps to not_running', async () => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-cli-'))
    // A socket file left behind by a killed process: connect() gets ECONNREFUSED.
    const { spawn } = await import('node:child_process')
    const stale = join(dir, 'stale.sock')
    const child = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(process.argv[1],()=>console.log('r'))`, stale],
      { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    await new Promise<void>((r) => child.stdout.once('data', () => r()))
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    child.kill('SIGKILL')
    await exited
    const res = await sendRequest(stale, buildRequest('projects.list', {}))
    expect(res).toEqual({ failure: { kind: 'not_running', socketPath: stale } })
  })

  it('server closing without a reply maps to closed', async () => {
    const path = await serve((_l, s) => s.destroy())
    expect(await sendRequest(path, buildRequest('projects.list', {}))).toEqual({
      failure: { kind: 'closed' }
    })
  })

  it('a malformed reply maps to an io failure', async () => {
    const path = await serve((_l, s) => s.write('garbage\n'))
    const res = await sendRequest(path, buildRequest('projects.list', {}))
    expect(res).toEqual({ failure: { kind: 'io', message: 'malformed reply from Octopus' } })
  })

  it('a reply for a different id is treated as malformed', async () => {
    const path = await serve((_l, s) => s.write('{"id":"other","ok":true,"result":{}}\n'))
    const res = await sendRequest(path, buildRequest('projects.list', {}, 'mine'))
    expect('failure' in res && res.failure.kind).toBe('io')
  })

  it('a reply split across chunks is reassembled', async () => {
    const path = await serve((line, s) => {
      const id = JSON.parse(line).id
      const full = JSON.stringify({ id, ok: true, result: { a: 1 } }) + '\n'
      s.write(full.slice(0, 7))
      setTimeout(() => s.write(full.slice(7)), 20)
    })
    const res = await sendRequest(path, buildRequest('projects.list', {}, 'z'))
    expect(res).toEqual({ reply: { id: 'z', ok: true, result: { a: 1 } } })
  })
})
