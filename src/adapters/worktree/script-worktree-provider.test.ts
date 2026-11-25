import { describe, it, expect } from 'vitest'
import {
  ScriptWorktreeProvider,
  CREATE_SCRIPT_NAME,
  DELETE_SCRIPT_NAME
} from './script-worktree-provider'
import type { PathProbe } from './path-safety'
import type { ScriptRunner, ScriptRunOptions, ScriptResult } from '../../ports/script-runner'
import type { Settings } from '../../ports/settings-store'
import { asTaskId } from '../../domain/ids'

/** A recording {@link ScriptRunner} whose result is scripted per test. */
interface RunCall {
  command: string
  args: readonly string[]
  opts: ScriptRunOptions
}

class FakeRunner implements ScriptRunner {
  calls: RunCall[] = []
  result: ScriptResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  rejectWith?: Error

  async run(
    command: string,
    args: readonly string[],
    opts: ScriptRunOptions
  ): Promise<ScriptResult> {
    this.calls.push({ command, args, opts })
    if (this.rejectWith) throw this.rejectWith
    // Stream stderr lines to the progress sink, exactly as the real runner does.
    if (opts.onStderrLine && this.result.stderr) {
      for (const line of this.result.stderr.split('\n')) {
        if (line) opts.onStderrLine(line)
      }
    }
    return this.result
  }
}

/** Probe reporting every path as an existing git worktree unless overridden. */
const goodProbe: PathProbe = {
  isDirectory: () => true,
  looksLikeGitWorktree: () => true
}

const SETTINGS: Settings = {
  worktree: { location: '/octopus_repos' },
  terminal: {},
  defaultSessionTypeId: 'terminal',
  worktreeCreateTimeoutMs: 12345,
  groupTasksByRepo: true
}

function provider(
  runner: FakeRunner,
  probe: PathProbe = goodProbe,
  onWarning?: (m: string) => void
) {
  return new ScriptWorktreeProvider({
    runner,
    getSettings: () => SETTINGS,
    probe,
    pathCanonical: 'exact',
    onWarning
  })
}

const createReq = {
  taskId: asTaskId('task5678abcd'),
  taskName: 'Alpha',
  repoDir: '/home/u/project',
  sourceBranch: 'main',
  newBranch: 'feature/x'
}

describe('ScriptWorktreeProvider.create (§6.4)', () => {
  it('runs <repoDir>/create_worktree.sh with (sourceBranch, newBranch), repoDir cwd/env', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: '/home/u/project/wt/feature-x\n' }

    const res = await provider(runner).create(createReq)

    expect(runner.calls).toHaveLength(1)
    const call = runner.calls[0]
    expect(call.command).toBe(`/home/u/project/${CREATE_SCRIPT_NAME}`)
    expect(call.args).toEqual(['main', 'feature/x'])
    expect(call.opts.cwd).toBe('/home/u/project')
    expect(call.opts.env).toMatchObject({
      OCTOPUS_REPO_ROOT: '/home/u/project',
      OCTOPUS_TASK_ID: 'task5678abcd'
    })
    expect(call.opts.timeoutMs).toBe(12345)
    // Returns the first non-empty stdout line as the path, plus provenance.
    expect(res.path).toBe('/home/u/project/wt/feature-x')
    expect(res.script).toBe(`/home/u/project/${CREATE_SCRIPT_NAME}`)
    expect(res.args).toEqual(['main', 'feature/x'])
  })

  it('takes the FIRST non-empty stdout line as the worktree path', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: '\n\n  /abs/path  \nsecond line\n' }
    const res = await provider(runner).create(createReq)
    expect(res.path).toBe('/abs/path')
  })

  it('streams stderr lines as progress (§6.4 diagnostics → stderr)', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: '/abs\n', stderr: 'step one\nstep two' }
    const progress: string[] = []
    await provider(runner).create(createReq, (l) => progress.push(l))
    expect(progress).toEqual(['step one', 'step two'])
  })

  it('rejects on a non-zero exit (task not created)', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, exitCode: 7, stderr: 'boom on stderr\ndetail' }
    await expect(provider(runner).create(createReq)).rejects.toThrow(/exit 7.*boom on stderr/)
  })

  it('rejects on timeout', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, timedOut: true }
    await expect(provider(runner).create(createReq)).rejects.toThrow(/timed out/)
  })

  it('rejects when the returned path fails validation (not a directory)', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: '/no/such/dir\n' }
    const badProbe: PathProbe = { isDirectory: () => false, looksLikeGitWorktree: () => false }
    await expect(provider(runner, badProbe).create(createReq)).rejects.toThrow(
      /does not exist or is not a directory/
    )
  })

  it('surfaces a warning (not a rejection) when the path lacks a .git marker', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: '/abs\n' }
    const noGitProbe: PathProbe = { isDirectory: () => true, looksLikeGitWorktree: () => false }
    const warnings: string[] = []
    const res = await provider(runner, noGitProbe, (m) => warnings.push(m)).create(createReq)
    expect(res.path).toBe('/abs')
    expect(warnings[0]).toMatch(/does not look like a git worktree/)
  })
})

describe('ScriptWorktreeProvider.remove (§6.4)', () => {
  const removeReq = {
    taskId: asTaskId('task5678abcd'),
    taskName: 'Alpha',
    path: '/home/u/project/wt/feature-x',
    repoDir: '/home/u/project'
  }

  it('runs <repoDir>/delete_worktree.sh with (taskName, path) after the safety check', async () => {
    const runner = new FakeRunner()
    await provider(runner).remove(removeReq)
    expect(runner.calls).toHaveLength(1)
    const call = runner.calls[0]
    expect(call.command).toBe(`/home/u/project/${DELETE_SCRIPT_NAME}`)
    expect(call.args).toEqual(['Alpha', '/home/u/project/wt/feature-x'])
    expect(call.opts.cwd).toBe('/home/u/project')
    expect(call.opts.env).toMatchObject({ OCTOPUS_REPO_ROOT: '/home/u/project' })
  })

  it('refuses to delete the repo root (safety check fires before the script)', async () => {
    const runner = new FakeRunner()
    await expect(
      provider(runner).remove({ ...removeReq, path: '/home/u/project' })
    ).rejects.toThrow(/repo root/)
    expect(runner.calls).toEqual([])
  })

  it('resolves even on a non-zero delete exit (task removed regardless, I4)', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, exitCode: 1, stderr: 'not fatal' }
    await expect(provider(runner).remove(removeReq)).resolves.toBeUndefined()
  })

  it('rejects when the script cannot be spawned (ENOENT)', async () => {
    const runner = new FakeRunner()
    runner.rejectWith = new Error('spawn ENOENT')
    await expect(provider(runner).remove(removeReq)).rejects.toThrow(/ENOENT/)
  })
})

describe('ScriptWorktreeProvider.isDirty (§6.4)', () => {
  it('runs git -C <wt> status --porcelain and maps non-empty output to dirty', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: ' M file\n' }
    expect(await provider(runner).isDirty('/wt')).toBe(true)
    const call = runner.calls[0]
    expect(call.command).toBe('git')
    expect(call.args).toEqual(['-C', '/wt', 'status', '--porcelain'])
  })

  it('reports dirty when git itself fails (cannot prove cleanliness)', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, exitCode: 128, stdout: '' }
    expect(await provider(runner).isDirty('/wt')).toBe(true)
  })

  it('reports clean on empty porcelain output', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: '' }
    expect(await provider(runner).isDirty('/wt')).toBe(false)
  })
})

describe('ScriptWorktreeProvider.inspectRepo / listWorktrees (§6.4 — never routed here)', () => {
  it('inspectRepo always rejects: SelectingWorktreeProvider routes it to native', async () => {
    const runner = new FakeRunner()
    await expect(provider(runner).inspectRepo()).rejects.toThrow(
      /ScriptWorktreeProvider.inspectRepo should never be called/
    )
    expect(runner.calls).toEqual([])
  })

  it('listWorktrees always rejects: SelectingWorktreeProvider routes it to native', async () => {
    const runner = new FakeRunner()
    await expect(provider(runner).listWorktrees()).rejects.toThrow(
      /ScriptWorktreeProvider.listWorktrees should never be called/
    )
    expect(runner.calls).toEqual([])
  })
})
