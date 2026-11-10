/**
 * End-to-end for the CLI entry point (`index.ts` runs on import): argv + stdin + env in,
 * stdout/stderr/exit code out, against a real Unix socket served by a tiny fake.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

let dir: string | undefined
let server: Server | undefined
const received: Array<Record<string, unknown>> = []

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  received.length = 0
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
})

async function serve(respond: (req: Record<string, unknown>) => unknown): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'octopus-cli-e2e-'))
  const path = join(dir, 'control.sock')
  server = createServer((s) => {
    let buf = ''
    s.on('data', (c) => {
      buf += c.toString()
      const i = buf.indexOf('\n')
      if (i < 0) return
      const req = JSON.parse(buf.slice(0, i)) as Record<string, unknown>
      received.push(req)
      s.write(JSON.stringify(respond(req)) + '\n')
    })
    s.on('error', () => undefined)
  })
  await new Promise<void>((r) => server!.listen(path, r))
  return path
}

async function runCli(
  argv: string[],
  opts: { socket?: string; stdin?: string } = {}
): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
  vi.resetModules()
  process.exitCode = undefined
  vi.stubEnv('OCTOPUS_CONTROL_SOCKET', opts.socket ?? '')
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cli.js', ...argv])
  if (opts.stdin !== undefined) {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([opts.stdin]) as unknown as typeof process.stdin
    )
  }
  let stdout = ''
  let stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
    stdout += c
    return true
  }) as never)
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => {
    stderr += c
    return true
  }) as never)

  await import('./index')
  for (let i = 0; i < 400 && process.exitCode === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  const code = process.exitCode as number | undefined
  process.exitCode = undefined
  return { code, stdout, stderr }
}

const okReply = (result: unknown) => (req: Record<string, unknown>) => ({
  id: req.id,
  ok: true,
  result
})

describe('octopus-cli entry', () => {
  it('--help prints the help on stdout, exit 0, without touching the socket', async () => {
    const r = await runCli(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('task create')
    expect(r.stderr).toBe('')
  })

  it('usage error: exit 2, message on stderr, nothing on stdout', async () => {
    const r = await runCli(['task', 'create', '--branch', 'b'])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('--project is required')
  })

  it('success: compact JSON on stdout, exit 0, request carries method and params', async () => {
    const socket = await serve(okReply({ taskId: 't1' }))
    const r = await runCli(['task', 'create', '--project', 'app', '--branch', 'b'], { socket })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ taskId: 't1' })
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(r.stderr).toBe('')
    expect(received[0]).toMatchObject({
      version: 1,
      method: 'task.create',
      params: { project: 'app', branch: 'b' }
    })
  })

  it('command error reply: exit 1, error JSON on stderr', async () => {
    const socket = await serve((req) => ({
      id: req.id,
      ok: false,
      error: { code: 'not_found', message: 'unknown task "x"' }
    }))
    const r = await runCli(['session', 'open', 'x'], { socket })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr)).toEqual({
      error: { code: 'not_found', message: 'unknown task "x"' }
    })
  })

  it('no listener (ENOENT): exit 3 and "Octopus is not running"', async () => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-cli-e2e-'))
    const r = await runCli(['projects', 'list'], { socket: join(dir, 'none.sock') })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr).error.message).toContain('Octopus is not running')
  })

  it('--command - reads the command from stdin with the trailing newline trimmed', async () => {
    const socket = await serve(okReply({ sessionId: 's1' }))
    const command = `claude -- "$(cat /tmp/f; rm -f /tmp/f)" # it's`
    const r = await runCli(['session', 'open', 't1', '--command', '-'], {
      socket,
      stdin: command + '\n'
    })
    expect(r.code).toBe(0)
    expect((received[0].params as Record<string, unknown>).command).toBe(command)
  })

  it('issues get --markdown prints readable markdown (real newlines, no JSON)', async () => {
    const socket = await serve(
      okReply({ issue: { id: 'i1', name: 'Fix it', status: 'todo', description: 'a\nb' } })
    )
    const r = await runCli(['issues', 'get', 'i1', '--markdown'], { socket })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('# Fix it\n\n- Id: i1\n- Status: todo\n\n## Description\n\na\nb\n')
    expect(received[0].params).toEqual({ issueId: 'i1' })
  })

  it('issues get --markdown still reports a command error as JSON on stderr', async () => {
    const socket = await serve((req) => ({
      id: req.id,
      ok: false,
      error: { code: 'not_found', message: 'unknown issue "x"' }
    }))
    const r = await runCli(['issues', 'get', 'x', '--markdown'], { socket })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr).error.code).toBe('not_found')
  })

  it('--description - reads the issue description from stdin', async () => {
    const socket = await serve(okReply({ issueId: 'i1' }))
    const r = await runCli(['issues', 'add', '--name', 'N', '--description', '-'], {
      socket,
      stdin: '# Title\n\nbody'
    })
    expect(r.code).toBe(0)
    expect(received[0].params).toEqual({ name: 'N', description: '# Title\n\nbody' })
  })

  it('without OCTOPUS_CONTROL_SOCKET falls back to the XDG data dir path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-cli-e2e-'))
    vi.stubEnv('XDG_DATA_HOME', dir)
    // vitest's stubEnv inside runCli sets the socket env to ''; falsy -> fallback path.
    const r = await runCli(['projects', 'list'])
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stderr).error.message).toContain(join(dir, 'octopus', 'control.sock'))
  })
})
