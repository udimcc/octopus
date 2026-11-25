/**
 * End-to-end worktree provisioning against a REAL throwaway git repo, driven
 * through the real ChildProcessScriptRunner (DESIGN §6.4). Exercises the full
 * V1 provider architecture — the repo-local `ScriptWorktreeProvider`, the
 * `NativeGitWorktreeProvider` (Octopus runs `git worktree` itself), and the
 * `SelectingWorktreeProvider` that dispatches between them per-call by probing
 * the task's repo dir — before any of it is wired to the UI.
 *
 * Requires `git` on PATH (present per the plan's env check); the whole suite is
 * skipped if git is somehow unavailable, rather than failing spuriously.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChildProcessScriptRunner } from '../../src/adapters/scripts/child-process-script-runner'
import {
  ScriptWorktreeProvider,
  CREATE_SCRIPT_NAME,
  DELETE_SCRIPT_NAME
} from '../../src/adapters/worktree/script-worktree-provider'
import { NativeGitWorktreeProvider } from '../../src/adapters/worktree/native-git-worktree-provider'
import { SelectingWorktreeProvider } from '../../src/adapters/worktree/selecting-worktree-provider'
import { fsPathProbe } from '../../src/adapters/worktree/fs-path-probe'
import { existsFile } from '../../src/adapters/fs/file-exists'
import { computeWorktreePath } from '../../src/adapters/worktree/worktree-path'
import type { Settings } from '../../src/ports/settings-store'
import { asTaskId } from '../../src/domain/ids'

const gitAvailable = spawnSync('git', ['--version']).status === 0
const d = gitAvailable ? describe : describe.skip

d('worktree providers (integration, §6.4)', () => {
  let root: string
  let repoDir: string
  let base: string
  let settings: Settings

  const runner = new ChildProcessScriptRunner()

  function git(args: string[], cwd: string): void {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    }
  }

  /** A minimal repo with one commit on `main` so `git worktree add` has a base. */
  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true })
    git(['init', '-q', '-b', 'main'], dir)
    // Neutralize any globally-configured hook template (this environment installs
    // company semver hooks into every new repo, which fail outside the monorepo).
    git(['config', 'core.hooksPath', join(root, 'nohooks')], dir)
    git(['config', 'user.email', 't@t'], dir)
    git(['config', 'user.name', 'T'], dir)
    git(['config', 'commit.gpgsign', 'false'], dir)
    writeFileSync(join(dir, 'README.md'), '# repo\n')
    git(['add', '.'], dir)
    git(['commit', '-q', '-m', 'init'], dir)
  }

  beforeEach(() => {
    // realpath: on macOS tmpdir() is under the /var -> /private/var symlink, and git
    // reports the resolved path.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-wt-')))
    repoDir = join(root, 'repo')
    base = join(root, 'octopus_repos')
    mkdirSync(base, { recursive: true })
    initRepo(repoDir)

    settings = {
      worktree: { location: base },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // ---- repo-local script provider -----------------------------------------

  /**
   * Drop `create_worktree.sh` / `delete_worktree.sh` INTO the repo dir (the §6.4
   * repo-local contract). Create reads $1=sourceBranch, $2=newBranch, writes the
   * chosen path to stdout and diagnostics to stderr; delete removes the tree.
   */
  function installRepoScripts(): void {
    const createScript = join(repoDir, CREATE_SCRIPT_NAME)
    writeFileSync(
      createScript,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'SOURCE="$1"; NEW="$2"',
        'WT="$(dirname "$OCTOPUS_REPO_ROOT")/scripted/${NEW//\\//-}"',
        'cd "$OCTOPUS_REPO_ROOT"',
        'echo "creating $WT from $SOURCE on $NEW (task $OCTOPUS_TASK_ID, v$OCTOPUS_VERSION)" 1>&2',
        'git worktree add -q -b "$NEW" "$WT" "$SOURCE" 1>&2',
        'echo "$WT"',
        ''
      ].join('\n')
    )
    chmodSync(createScript, 0o755)

    const deleteScript = join(repoDir, DELETE_SCRIPT_NAME)
    writeFileSync(
      deleteScript,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'TASK_NAME="$1"; WT="$2"',
        'cd "$OCTOPUS_REPO_ROOT"',
        'git worktree remove --force "$WT"',
        ''
      ].join('\n')
    )
    chmodSync(deleteScript, 0o755)
  }

  function scriptProvider(): ScriptWorktreeProvider {
    return new ScriptWorktreeProvider({ runner, getSettings: () => settings, probe: fsPathProbe })
  }

  function nativeProvider(): NativeGitWorktreeProvider {
    return new NativeGitWorktreeProvider({
      runner,
      getSettings: () => settings,
      resolveBase: () => base,
      probe: fsPathProbe
    })
  }

  function selecting(): SelectingWorktreeProvider {
    return new SelectingWorktreeProvider({
      script: scriptProvider(),
      native: nativeProvider(),
      hasScript: existsFile
    })
  }

  describe('ScriptWorktreeProvider (repo-local create_worktree.sh)', () => {
    it('creates a real worktree, returns its path, and streams stderr progress', async () => {
      installRepoScripts()
      const progress: string[] = []
      const res = await scriptProvider().create(
        {
          taskId: asTaskId('task1234'),
          taskName: 'alpha',
          repoDir,
          sourceBranch: 'main',
          newBranch: 'feature/alpha'
        },
        (line) => progress.push(line)
      )
      expect(res.path).toBe(join(root, 'scripted', 'feature-alpha'))
      expect(existsSync(res.path)).toBe(true)
      expect(existsSync(join(res.path, '.git'))).toBe(true)
      expect(existsSync(join(res.path, 'README.md'))).toBe(true)
      expect(res.args).toEqual(['main', 'feature/alpha'])
      expect(progress.join('\n')).toMatch(
        /creating .*from main on feature\/alpha \(task task1234, v1\)/
      )
    })

    it('removes a real worktree via delete_worktree.sh', async () => {
      installRepoScripts()
      const res = await scriptProvider().create({
        taskId: asTaskId('task1234'),
        taskName: 'gamma',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'gamma'
      })
      expect(existsSync(res.path)).toBe(true)
      await scriptProvider().remove({
        taskId: asTaskId('task1234'),
        taskName: 'gamma',
        path: res.path,
        repoDir
      })
      expect(existsSync(res.path)).toBe(false)
    })

    it('rejects when the create script exits non-zero (bad source branch)', async () => {
      installRepoScripts()
      await expect(
        scriptProvider().create({
          taskId: asTaskId('t'),
          taskName: 'z',
          repoDir,
          sourceBranch: 'does-not-exist',
          newBranch: 'z'
        })
      ).rejects.toThrow(/create worktree script failed/)
    })
  })

  describe('NativeGitWorktreeProvider (Octopus runs git worktree)', () => {
    it('creates a worktree at the computed path under the configured base dir', async () => {
      const taskId = asTaskId('abcdef0123456789')
      // A progress sink is accepted (stderr streaming is unit-tested; git's exact
      // wording varies by version, so we don't assert on it here).
      const res = await nativeProvider().create(
        { taskId, taskName: 'native', repoDir, sourceBranch: 'main', newBranch: 'feature/native' },
        () => undefined
      )
      const expected = computeWorktreePath({ base, newBranch: 'feature/native', taskId })
      expect(res.path).toBe(expected)
      expect(res.path.startsWith(`${base}/`)).toBe(true)
      expect(existsSync(res.path)).toBe(true)
      expect(existsSync(join(res.path, '.git'))).toBe(true)
      expect(existsSync(join(res.path, 'README.md'))).toBe(true)
      expect(res.script).toBe('git')
    })

    it('reports clean, then dirty after an edit (§6.4 dirty gate)', async () => {
      const res = await nativeProvider().create({
        taskId: asTaskId('abcdef0123456789'),
        taskName: 'beta',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'beta'
      })
      expect(await nativeProvider().isDirty(res.path)).toBe(false)
      writeFileSync(join(res.path, 'new.txt'), 'uncommitted\n')
      expect(await nativeProvider().isDirty(res.path)).toBe(true)
    })

    it('removes a clean worktree with git worktree remove', async () => {
      const taskId = asTaskId('abcdef0123456789')
      const res = await nativeProvider().create({
        taskId,
        taskName: 'rm',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'rm'
      })
      expect(existsSync(res.path)).toBe(true)
      await nativeProvider().remove({ taskId, taskName: 'rm', path: res.path, repoDir })
      expect(existsSync(res.path)).toBe(false)
    })

    it('needs --force (confirmedDirty) to remove a worktree with uncommitted changes', async () => {
      const taskId = asTaskId('abcdef0123456789')
      const res = await nativeProvider().create({
        taskId,
        taskName: 'dirty',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'dirty'
      })
      writeFileSync(join(res.path, 'dirt.txt'), 'uncommitted\n')

      // Without --force git refuses; the record would strand — but remove() resolves
      // regardless of exit code (I4), so the tree simply survives.
      await nativeProvider().remove({ taskId, taskName: 'dirty', path: res.path, repoDir })
      expect(existsSync(res.path)).toBe(true)

      // With confirmedDirty → --force, git removes it.
      await nativeProvider().remove({
        taskId,
        taskName: 'dirty',
        path: res.path,
        repoDir,
        confirmedDirty: true
      })
      expect(existsSync(res.path)).toBe(false)
    })

    it('refuses to delete the repo root (safety check fires before git)', async () => {
      await expect(
        nativeProvider().remove({
          taskId: asTaskId('t'),
          taskName: 'x',
          path: repoDir,
          repoDir
        })
      ).rejects.toThrow(/repo root/)
      expect(existsSync(join(repoDir, 'README.md'))).toBe(true)
    })
  })

  describe('SelectingWorktreeProvider (per-call dispatch)', () => {
    it('uses the repo-local script when create_worktree.sh is present', async () => {
      installRepoScripts()
      const res = await selecting().create({
        taskId: asTaskId('task1234'),
        taskName: 'sel-script',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'sel/script'
      })
      // The script places worktrees under <root>/scripted, NOT the native base.
      expect(res.path).toBe(join(root, 'scripted', 'sel-script'))
      expect(res.path.startsWith(base)).toBe(false)
      expect(existsSync(res.path)).toBe(true)
    })

    it('falls back to native git when the repo has no create_worktree.sh', async () => {
      // No installRepoScripts() → script-less repo.
      const taskId = asTaskId('abcdef0123456789')
      const res = await selecting().create({
        taskId,
        taskName: 'sel-native',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'sel/native'
      })
      expect(res.path.startsWith(`${base}/`)).toBe(true)
      expect(res.script).toBe('git')
      expect(existsSync(res.path)).toBe(true)
    })
  })

  describe('NativeGitWorktreeProvider.inspectRepo / listWorktrees (§6.4, real git)', () => {
    it('resolves the repo root and falls back to the current branch (no origin/HEAD)', async () => {
      const res = await nativeProvider().inspectRepo(repoDir)
      expect(res.root).toBe(repoDir)
      expect(res.defaultBranch).toBe('main')
    })

    it('resolves a real linked worktree dir back to the main repo root', async () => {
      const taskId = asTaskId('abcdef0123456789')
      const created = await nativeProvider().create({
        taskId,
        taskName: 'linked',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'linked'
      })

      const res = await nativeProvider().inspectRepo(created.path)
      expect(res.root).toBe(repoDir)
    })

    it('rejects a non-git directory', async () => {
      const plainDir = join(root, 'not-a-repo')
      mkdirSync(plainDir)
      await expect(nativeProvider().inspectRepo(plainDir)).rejects.toThrow(/not a git repository/)
    })

    it('lists the main checkout and a real linked worktree with their branches', async () => {
      const taskId = asTaskId('abcdef0123456789')
      const created = await nativeProvider().create({
        taskId,
        taskName: 'list-me',
        repoDir,
        sourceBranch: 'main',
        newBranch: 'list/me'
      })

      const res = await nativeProvider().listWorktrees(repoDir)
      expect(res).toEqual([
        { path: repoDir, branch: 'main' },
        { path: created.path, branch: 'list/me' }
      ])
    })

    it('resolves the default branch from origin/HEAD, stripped of the origin/ prefix', async () => {
      const bareDir = join(root, 'origin.git')
      git(['init', '--bare', '-q', bareDir], root)
      // Same hooks neutralization as initRepo (~line 55) — a bare repo can still
      // trigger server-side hooks (e.g. pre-receive) on push.
      git(['config', 'core.hooksPath', join(root, 'nohooks')], bareDir)
      git(['remote', 'add', 'origin', bareDir], repoDir)
      git(['push', '-q', 'origin', 'main'], repoDir)
      // Sets refs/remotes/origin/HEAD locally without needing the remote to push back.
      git(['remote', 'set-head', 'origin', 'main'], repoDir)
      // Move the checked-out branch away from origin/HEAD so a fallback to the
      // current branch can't accidentally produce the same answer ('main') and
      // mask a broken symbolic-ref path.
      git(['checkout', '-q', '-b', 'feature/wip'], repoDir)

      const res = await nativeProvider().inspectRepo(repoDir)
      expect(res.defaultBranch).toBe('main')
    })
  })
})
