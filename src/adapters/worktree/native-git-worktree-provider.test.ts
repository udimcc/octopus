import { describe, it, expect } from 'vitest'
import { NativeGitWorktreeProvider } from './native-git-worktree-provider'
import type { PathProbe } from './path-safety'
import type { ScriptRunner, ScriptRunOptions, ScriptResult } from '../../ports/script-runner'
import type { Settings } from '../../ports/settings-store'
import { asTaskId } from '../../domain/ids'

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
    if (opts.onStderrLine && this.result.stderr) {
      for (const line of this.result.stderr.split('\n')) {
        if (line) opts.onStderrLine(line)
      }
    }
    return this.result
  }
}

const goodProbe: PathProbe = {
  isDirectory: () => true,
  looksLikeGitWorktree: () => true
}

const SETTINGS: Settings = {
  worktree: { location: '/base' },
  terminal: {},
  defaultSessionTypeId: 'terminal',
  worktreeCreateTimeoutMs: 9999
}

const BASE = '/base'

function provider(
  runner: ScriptRunner,
  probe: PathProbe = goodProbe,
  onWarning?: (m: string) => void
) {
  return new NativeGitWorktreeProvider({
    runner,
    getSettings: () => SETTINGS,
    resolveBase: () => BASE,
    probe,
    onWarning
  })
}

const createReq = {
  taskId: asTaskId('abcdef0123456789'),
  taskName: 'Alpha',
  repoDir: '/home/u/project',
  sourceBranch: 'main',
  newBranch: 'feature/login'
}

// computeWorktreePath is pure and covered separately; here we assert the wiring.
const EXPECTED_PATH = '/base/feature-login-abcdef01'

describe('NativeGitWorktreeProvider.create (§6.4)', () => {
  it('runs git -C <repoDir> worktree add -b <newBranch> <computedPath> <sourceBranch>', async () => {
    const runner = new FakeRunner()
    const res = await provider(runner).create(createReq)

    expect(runner.calls).toHaveLength(1)
    const call = runner.calls[0]
    expect(call.command).toBe('git')
    expect(call.args).toEqual([
      '-C',
      '/home/u/project',
      'worktree',
      'add',
      '-b',
      'feature/login',
      EXPECTED_PATH,
      'main'
    ])
    expect(call.opts.cwd).toBe('/home/u/project')
    expect(call.opts.env).toMatchObject({ OCTOPUS_REPO_ROOT: '/home/u/project' })
    expect(call.opts.timeoutMs).toBe(9999)

    // Octopus (not a script) chose the path — provenance is git + the argv.
    expect(res.path).toBe(EXPECTED_PATH)
    expect(res.script).toBe('git')
    expect(res.args).toEqual(call.args)
  })

  it('places the worktree flat under the resolved base dir', async () => {
    const runner = new FakeRunner()
    const res = await provider(runner).create(createReq)
    expect(res.path.startsWith(`${BASE}/`)).toBe(true)
    expect(res.path.slice(BASE.length + 1)).not.toContain('/') // flat, no nesting
  })

  it('streams git stderr as progress', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stderr: 'Preparing worktree\nHEAD is now at abc123' }
    const progress: string[] = []
    await provider(runner).create(createReq, (l) => progress.push(l))
    expect(progress).toEqual(['Preparing worktree', 'HEAD is now at abc123'])
  })

  it('rejects on a non-zero git exit (bad source branch)', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, exitCode: 128, stderr: 'fatal: invalid reference: nope' }
    await expect(provider(runner).create(createReq)).rejects.toThrow(/exit 128.*invalid reference/)
  })

  it('rejects on timeout', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, timedOut: true }
    await expect(provider(runner).create(createReq)).rejects.toThrow(/timed out/)
  })

  it('rejects when git succeeds but the path fails validation', async () => {
    const runner = new FakeRunner()
    const badProbe: PathProbe = { isDirectory: () => false, looksLikeGitWorktree: () => false }
    await expect(provider(runner, badProbe).create(createReq)).rejects.toThrow(
      /does not exist or is not a directory/
    )
  })
})

describe('NativeGitWorktreeProvider.remove (§6.4)', () => {
  const removeReq = {
    taskId: asTaskId('abcdef0123456789'),
    taskName: 'Alpha',
    path: EXPECTED_PATH,
    repoDir: '/home/u/project'
  }

  it('runs git -C <repoDir> worktree remove <path> (no --force when clean)', async () => {
    const runner = new FakeRunner()
    await provider(runner).remove(removeReq)
    const call = runner.calls[0]
    expect(call.command).toBe('git')
    expect(call.args).toEqual(['-C', '/home/u/project', 'worktree', 'remove', EXPECTED_PATH])
    expect(call.opts.cwd).toBe('/home/u/project')
  })

  it('adds --force only when the caller confirmed a dirty delete', async () => {
    const runner = new FakeRunner()
    await provider(runner).remove({ ...removeReq, confirmedDirty: true })
    expect(runner.calls[0].args).toEqual([
      '-C',
      '/home/u/project',
      'worktree',
      'remove',
      EXPECTED_PATH,
      '--force'
    ])
  })

  it('refuses to delete the repo root before git runs', async () => {
    const runner = new FakeRunner()
    await expect(
      provider(runner).remove({ ...removeReq, path: '/home/u/project' })
    ).rejects.toThrow(/repo root/)
    expect(runner.calls).toEqual([])
  })

  it('resolves even on a non-zero git exit (I4)', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, exitCode: 1 }
    await expect(provider(runner).remove(removeReq)).resolves.toBeUndefined()
  })

  it('rejects when git cannot be spawned', async () => {
    const runner = new FakeRunner()
    runner.rejectWith = new Error('spawn ENOENT')
    await expect(provider(runner).remove(removeReq)).rejects.toThrow(/ENOENT/)
  })
})

/**
 * `adopt` issues two git calls (`worktree list --porcelain`, then `rev-parse`), so
 * it needs per-call results — this runner dispatches by the git subcommand.
 */
class AdoptRunner implements ScriptRunner {
  calls: RunCall[] = []
  list: ScriptResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  revParse: ScriptResult = {
    exitCode: 0,
    signal: null,
    stdout: 'feature/x\n',
    stderr: '',
    timedOut: false
  }

  async run(
    command: string,
    args: readonly string[],
    opts: ScriptRunOptions
  ): Promise<ScriptResult> {
    this.calls.push({ command, args, opts })
    if (args.includes('rev-parse')) return this.revParse
    return this.list
  }
}

describe('NativeGitWorktreeProvider.adopt (§6.4)', () => {
  const adoptReq = {
    taskId: asTaskId('abcdef0123456789'),
    taskName: 'Alpha',
    worktreeDir: '/home/u/worktrees/wt-x'
  }
  // The FIRST porcelain `worktree ` line is the main worktree = the repo root.
  const porcelain =
    'worktree /home/u/project\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/worktrees/wt-x\nHEAD def\nbranch refs/heads/feature/x\n'

  it('returns the first porcelain entry as repoRoot, the picked dir as path, and the branch', async () => {
    const runner = new AdoptRunner()
    runner.list = { ...runner.list, stdout: porcelain }
    runner.revParse = { ...runner.revParse, stdout: 'feature/x\n' }

    const res = await provider(runner).adopt(adoptReq)

    expect(res.repoRoot).toBe('/home/u/project')
    expect(res.path).toBe('/home/u/worktrees/wt-x')
    expect(res.branch).toBe('feature/x')

    // Read-only, argv-only, run in the picked directory.
    expect(runner.calls[0].args).toEqual([
      '-C',
      '/home/u/worktrees/wt-x',
      'worktree',
      'list',
      '--porcelain'
    ])
    expect(runner.calls[0].opts.cwd).toBe('/home/u/worktrees/wt-x')
  })

  it('treats a detached HEAD (rev-parse → HEAD) as no branch', async () => {
    const runner = new AdoptRunner()
    runner.list = { ...runner.list, stdout: porcelain }
    runner.revParse = { ...runner.revParse, stdout: 'HEAD\n' }

    const res = await provider(runner).adopt(adoptReq)
    expect(res.branch).toBeUndefined()
  })

  it('rejects a non-git directory (git worktree list non-zero)', async () => {
    const runner = new AdoptRunner()
    runner.list = { ...runner.list, exitCode: 128, stderr: 'fatal: not a git repository' }
    await expect(provider(runner).adopt(adoptReq)).rejects.toThrow(/not a git worktree/)
  })

  it('refuses the repository main working tree (would be undeletable)', async () => {
    const runner = new AdoptRunner()
    // Picked dir IS the main worktree → first porcelain entry equals it.
    runner.list = {
      ...runner.list,
      stdout: 'worktree /home/u/worktrees/wt-x\nHEAD abc\nbranch refs/heads/main\n'
    }
    await expect(provider(runner).adopt(adoptReq)).rejects.toThrow(/main working tree/)
  })

  it('rejects when the picked directory fails validation', async () => {
    const runner = new AdoptRunner()
    const badProbe: PathProbe = { isDirectory: () => false, looksLikeGitWorktree: () => false }
    await expect(provider(runner, badProbe).adopt(adoptReq)).rejects.toThrow(
      /does not exist or is not a directory/
    )
    // Validation happens before any git call.
    expect(runner.calls).toEqual([])
  })
})

describe('NativeGitWorktreeProvider.isDirty (§6.4)', () => {
  it('delegates to git status --porcelain', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: '?? untracked\n' }
    expect(await provider(runner).isDirty('/wt')).toBe(true)
    expect(runner.calls[0].args).toEqual(['-C', '/wt', 'status', '--porcelain'])
  })
})
