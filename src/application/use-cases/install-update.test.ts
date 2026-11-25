import { describe, it, expect, vi } from 'vitest'
import { createUpdateInstaller } from './install-update'
import type { ScriptRunner, ScriptResult } from '../../ports/script-runner'
import type { AppRelauncher, UpdateSource } from '../../ports/update-source'

const okResult: ScriptResult = {
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false
}

function setup(
  opts: {
    run?: () => Promise<ScriptResult>
    stage?: () => Promise<string>
    installScript?: string
    executablePath?: string
  } = {}
) {
  const calls: string[] = []
  const source: UpdateSource = {
    listCandidates: vi.fn(),
    stageToTemp: vi.fn(async () => {
      calls.push('stage')
      return opts.stage ? opts.stage() : '/tmp/stage'
    }),
    cleanup: vi.fn(async () => {
      calls.push('cleanup')
    })
  }
  const run = vi.fn(async () => {
    calls.push('run')
    return opts.run ? opts.run() : okResult
  })
  const scriptRunner = { run } as unknown as ScriptRunner
  const relauncher: AppRelauncher = {
    relaunch: vi.fn(() => {
      calls.push('relaunch')
    })
  }
  const installer = createUpdateInstaller({
    source,
    scriptRunner,
    relauncher,
    programDir: '/prog',
    ...(opts.installScript !== undefined ? { installScript: opts.installScript } : {}),
    ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
    timeoutMs: 999
  })
  return { installer, source, run, relauncher, calls }
}

describe('createUpdateInstaller', () => {
  it('stages, runs sh <tmp>/install.sh with cwd tmp, cleans up BEFORE relaunch', async () => {
    const { installer, run, relauncher, calls, source } = setup()
    expect(await installer.install('/rel/octopus-1.2.0')).toEqual({ ok: true })
    expect(source.stageToTemp).toHaveBeenCalledWith('/rel/octopus-1.2.0')
    expect(run).toHaveBeenCalledWith('sh', ['/tmp/stage/install.sh'], {
      cwd: '/tmp/stage',
      timeoutMs: 999,
      killProcessGroup: true
    })
    expect(relauncher.relaunch).toHaveBeenCalledWith('/prog/octopus')
    expect(calls).toEqual(['stage', 'run', 'cleanup', 'relaunch'])
    expect(source.cleanup).toHaveBeenCalledTimes(1)
  })

  it('macOS: runs the configured install script and relaunches the configured binary', async () => {
    const { installer, run, relauncher } = setup({
      installScript: 'install-mac.sh',
      executablePath: '/Apps/Octopus.app/Contents/MacOS/Octopus'
    })
    expect(await installer.install('/rel/octopus-1.3.0')).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('sh', ['/tmp/stage/install-mac.sh'], {
      cwd: '/tmp/stage',
      timeoutMs: 999,
      killProcessGroup: true
    })
    expect(relauncher.relaunch).toHaveBeenCalledWith('/Apps/Octopus.app/Contents/MacOS/Octopus')
  })

  it('non-zero exit: error includes exit code and stderr tail, cleans up, no relaunch', async () => {
    const { installer, relauncher, source } = setup({
      run: async () => ({ ...okResult, exitCode: 3, stderr: 'boom\n' })
    })
    const res = await installer.install('/r')
    expect(res).toEqual({ ok: false, error: 'Install failed (exit 3): boom' })
    expect(relauncher.relaunch).not.toHaveBeenCalled()
    expect(source.cleanup).toHaveBeenCalledWith('/tmp/stage')
  })

  it('truncates stderr to the last 500 chars', async () => {
    const { installer } = setup({
      run: async () => ({ ...okResult, exitCode: 1, stderr: 'a'.repeat(2000) + 'END' })
    })
    const res = await installer.install('/r')
    expect(res.ok).toBe(false)
    const err = (res as { error: string }).error
    expect(err).toContain('...')
    expect(err.endsWith('END')).toBe(true)
    expect(err.length).toBeLessThan(600)
  })

  it('timeout: reports "Install timed out" even when exitCode is 0', async () => {
    const { installer, relauncher, source } = setup({
      run: async () => ({
        ...okResult,
        exitCode: 0,
        signal: null,
        timedOut: true,
        stderr: 'slow'
      })
    })
    const res = await installer.install('/r')
    expect(res).toEqual({ ok: false, error: 'Install timed out: slow' })
    expect(relauncher.relaunch).not.toHaveBeenCalled()
    expect(source.cleanup).toHaveBeenCalledWith('/tmp/stage')
  })

  it('signal exit without stderr reports the signal', async () => {
    const { installer, source } = setup({
      run: async () => ({ ...okResult, exitCode: null, signal: 'SIGKILL' })
    })
    expect(await installer.install('/r')).toEqual({
      ok: false,
      error: 'Install failed (exit SIGKILL)'
    })
    expect(source.cleanup).toHaveBeenCalledWith('/tmp/stage')
  })

  it('stage failure: returns error, never runs the script, no cleanup of unknown tmp', async () => {
    const { installer, run, source } = setup({
      stage: async () => {
        throw new Error('copy exploded')
      }
    })
    expect(await installer.install('/r')).toEqual({ ok: false, error: 'copy exploded' })
    expect(run).not.toHaveBeenCalled()
    expect(source.cleanup).not.toHaveBeenCalled()
  })

  it('runner rejection (spawn failure) maps to an error and still cleans up', async () => {
    const { installer, source } = setup({
      run: async () => {
        throw new Error('ENOENT')
      }
    })
    expect(await installer.install('/r')).toEqual({ ok: false, error: 'ENOENT' })
    expect(source.cleanup).toHaveBeenCalledWith('/tmp/stage')
  })

  it('a throwing cleanup after success does not fail the install', async () => {
    const h = setup()
    vi.mocked(h.source.cleanup).mockRejectedValue(new Error('rm failed'))
    expect(await h.installer.install('/r')).toEqual({ ok: true })
    expect(h.relauncher.relaunch).toHaveBeenCalled()
  })

  it('rejects a concurrent install, then allows another after the first finishes', async () => {
    let release!: (r: ScriptResult) => void
    let n = 0
    const h = setup({
      run: () => (n++ === 0 ? new Promise((r) => (release = r)) : Promise.resolve(okResult))
    })
    const first = h.installer.install('/r')
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled())
    expect(await h.installer.install('/r')).toEqual({
      ok: false,
      error: 'An install is already in progress'
    })
    release({ ...okResult, exitCode: 1 })
    expect((await first).ok).toBe(false)
    expect(await h.installer.install('/r')).toEqual({ ok: true })
  })
})
