import { describe, it, expect } from 'vitest'
import { ChildProcessScriptRunner, buildEnv } from './child-process-script-runner'

const node = process.execPath
const runner = new ChildProcessScriptRunner()

describe('buildEnv (I17)', () => {
  it('overlays overrides on the inherited env', () => {
    const env = buildEnv({ PATH: '/bin', HOME: '/h' }, { OCTOPUS_TASK_ID: 't1' })
    expect(env.PATH).toBe('/bin')
    expect(env.OCTOPUS_TASK_ID).toBe('t1')
  })

  it('drops undefined inherited values (never stringifies to "undefined")', () => {
    const env = buildEnv({ A: 'x', B: undefined }, undefined)
    expect(env.A).toBe('x')
    expect('B' in env).toBe(false)
  })

  it('lets an override replace an inherited value', () => {
    const env = buildEnv({ SHELL: '/bin/sh' }, { SHELL: '/bin/zsh' })
    expect(env.SHELL).toBe('/bin/zsh')
  })
})

describe('ChildProcessScriptRunner (§6.4)', () => {
  it('captures stdout, exit code 0, and streams stdout lines', async () => {
    const lines: string[] = []
    const res = await runner.run(node, ['-e', 'console.log("one");console.log("two")'], {
      cwd: process.cwd(),
      onStdoutLine: (l) => lines.push(l)
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim().split('\n')).toEqual(['one', 'two'])
    expect(lines).toEqual(['one', 'two'])
    expect(res.timedOut).toBe(false)
  })

  it('reports a non-zero exit without rejecting, and streams stderr separately', async () => {
    const errLines: string[] = []
    const res = await runner.run(node, ['-e', 'console.error("boom");process.exit(3)'], {
      cwd: process.cwd(),
      onStderrLine: (l) => errLines.push(l)
    })
    expect(res.exitCode).toBe(3)
    expect(res.stderr).toMatch(/boom/)
    expect(errLines).toContain('boom')
  })

  it('does NOT interpret shell metacharacters (I17 — argv, never a shell)', async () => {
    // If this were run through a shell, `; echo INJECTED` would execute. As argv,
    // the whole string is a single argument printed verbatim.
    const payload = 'hello; echo INJECTED'
    const res = await runner.run(node, ['-e', 'console.log(process.argv[1])', payload], {
      cwd: process.cwd()
    })
    // Verbatim single line: a shell would have put INJECTED on its OWN line.
    expect(res.stdout).toBe('hello; echo INJECTED\n')
    expect(res.stdout).not.toContain('\nINJECTED')
    expect(res.exitCode).toBe(0)
  })

  it('passes the OCTOPUS_* env through to the child', async () => {
    const res = await runner.run(
      node,
      ['-e', 'process.stdout.write(process.env.OCTOPUS_TASK_ID||"")'],
      {
        cwd: process.cwd(),
        env: { OCTOPUS_TASK_ID: 'task-xyz' }
      }
    )
    expect(res.stdout).toBe('task-xyz')
  })

  it('runs in the requested cwd', async () => {
    const res = await runner.run(node, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: '/tmp'
    })
    // macOS may symlink /tmp → /private/tmp; accept either.
    expect(['/tmp', '/private/tmp']).toContain(res.stdout)
  })

  it('times out a hung child: SIGTERM then result.timedOut', async () => {
    const res = await runner.run(node, ['-e', 'setTimeout(()=>{}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 100,
      graceMs: 100
    })
    expect(res.timedOut).toBe(true)
    // Killed by signal, so exitCode is null and a signal is present.
    expect(res.signal === 'SIGTERM' || res.signal === 'SIGKILL').toBe(true)
  })

  it('caps captured stderr at maxStderrBytes', async () => {
    const res = await runner.run(node, ['-e', 'process.stderr.write("x".repeat(10000))'], {
      cwd: process.cwd(),
      maxStderrBytes: 100
    })
    expect(res.stderr.length).toBe(100)
  })

  it('rejects on spawn failure (ENOENT)', async () => {
    await expect(runner.run('/no/such/binary-xyz', [], { cwd: process.cwd() })).rejects.toThrow()
  })
})
