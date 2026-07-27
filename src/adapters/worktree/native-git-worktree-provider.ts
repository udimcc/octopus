/**
 * `WorktreeProvider` where Octopus runs `git worktree` ITSELF (DESIGN §6.4). Used
 * when a task's repo directory has no `create_worktree.sh` — the script-less
 * default path. Git is invoked through the SAME argv-only {@link ScriptRunner}
 * (I17, `shell:false`), so an untrusted branch name is never interpolated into a
 * shell — it is just an argv string git receives verbatim.
 *
 * `create`:
 *   - computes a FLAT path under the resolved base dir `worktree.location`
 *     (`<base>/<sanitized-new-branch>-<short-task-id>`, {@link computeWorktreePath}),
 *     ensuring the base exists first (git won't create the parent).
 *   - runs `git -C <repoDir> worktree add -b <newBranch> <computedPath> <sourceBranch>`;
 *     stderr streams as progress. Non-zero exit / timeout / invalid path → reject.
 *
 * `remove`:
 *   - `assertSafeToDelete` (containment, §6.4) BEFORE git runs.
 *   - runs `git -C <repoDir> worktree remove <path>` — with `--force` when the
 *     caller confirmed a dirty delete (git refuses a dirty tree otherwise, §6.4).
 *   - resolves even on non-zero exit (I4); rejects only on spawn failure.
 *
 * `isDirty`: shared `git status --porcelain` helper.
 */

import { normalize, sep } from 'node:path'
import type { Settings } from '../../ports/settings-store'
import type { ScriptRunner } from '../../ports/script-runner'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  AdoptWorktreeRequest,
  AdoptWorktreeResult,
  RemoveWorktreeRequest
} from '../../ports/worktree-provider'
import { validateWorktreePath, assertSafeToDelete, type PathProbe } from './path-safety'
import { fsPathProbe } from './fs-path-probe'
import { computeWorktreePath } from './worktree-path'
import { GIT, scriptEnv, firstNonEmptyLine, firstLine, gitIsDirty } from './worktree-support'

/** Normalize + strip a single trailing separator (keep root) for path identity. */
function canonPath(p: string): string {
  const n = normalize(p.trim())
  if (n.length > 1 && n.endsWith(sep)) {
    return n.slice(0, -1)
  }
  return n
}

/**
 * The main worktree path from `git worktree list --porcelain` output: the value
 * of the FIRST `worktree ` record (git always lists the main worktree first).
 * Returns `''` if no `worktree ` line is present.
 */
function parseMainWorktree(porcelain: string): string {
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      return line.slice('worktree '.length).trim()
    }
  }
  return ''
}

export interface NativeGitWorktreeProviderDeps {
  readonly runner: ScriptRunner
  /** Live settings accessor (create timeout). */
  readonly getSettings: () => Settings
  /**
   * Resolve (and ensure on disk) the base dir for native worktrees — the
   * composition root wires this to `ensureWorktreeBase(resolveWorktreeBase(...))`,
   * so path/default policy stays out of this adapter (§6.4).
   */
  readonly resolveBase: () => string
  /** Path probe for validation; defaults to the real fs probe. */
  readonly probe?: PathProbe
  /** Sink for the non-fatal "doesn't look like a worktree" warning (§6.4). */
  readonly onWarning?: (message: string) => void
}

export class NativeGitWorktreeProvider implements WorktreeProvider {
  private readonly runner: ScriptRunner
  private readonly getSettings: () => Settings
  private readonly resolveBase: () => string
  private readonly probe: PathProbe
  private readonly onWarning?: (message: string) => void

  constructor(deps: NativeGitWorktreeProviderDeps) {
    this.runner = deps.runner
    this.getSettings = deps.getSettings
    this.resolveBase = deps.resolveBase
    this.probe = deps.probe ?? fsPathProbe
    this.onWarning = deps.onWarning
  }

  async create(
    req: CreateWorktreeRequest,
    onProgress?: (line: string) => void
  ): Promise<CreateWorktreeResult> {
    const settings = this.getSettings()
    const base = this.resolveBase()
    const worktreePath = computeWorktreePath({
      base,
      newBranch: req.newBranch,
      taskId: req.taskId
    })

    const args = [
      '-C',
      req.repoDir,
      'worktree',
      'add',
      '-b',
      req.newBranch,
      worktreePath,
      req.sourceBranch
    ]

    const result = await this.runner.run(GIT, args, {
      cwd: req.repoDir,
      env: scriptEnv(req.taskId, req.repoDir),
      timeoutMs: settings.worktreeCreateTimeoutMs,
      onStderrLine: onProgress
    })

    if (result.timedOut) {
      throw new Error(`git worktree add timed out (${worktreePath})`)
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree add failed (exit ${result.exitCode ?? result.signal}): ${firstLine(result.stderr)}`
      )
    }

    // Git created the path we chose; validate it the same way as a script's path.
    const validation = validateWorktreePath(worktreePath, this.probe)
    if (!validation.ok) {
      throw new Error(validation.error)
    }
    if (validation.warning) {
      this.onWarning?.(validation.warning)
    }

    return { path: worktreePath, script: GIT, args }
  }

  async adopt(req: AdoptWorktreeRequest): Promise<AdoptWorktreeResult> {
    // Validate the picked directory the same way as a created path (absolute,
    // exists, is a dir; a missing `.git` is a non-fatal warning, §6.4).
    const validation = validateWorktreePath(req.worktreeDir, this.probe)
    if (!validation.ok) {
      throw new Error(validation.error)
    }
    if (validation.warning) {
      this.onWarning?.(validation.warning)
    }

    const env = scriptEnv(req.taskId, req.worktreeDir)

    // The FIRST `worktree ` line of the porcelain listing is always the main
    // worktree — its path is the repo root we store for delete safety (§6.4).
    const list = await this.runner.run(
      GIT,
      ['-C', req.worktreeDir, 'worktree', 'list', '--porcelain'],
      {
        cwd: req.worktreeDir,
        env
      }
    )
    if (list.exitCode !== 0) {
      throw new Error(`not a git worktree: ${req.worktreeDir} (${firstLine(list.stderr)})`)
    }
    const repoRoot = parseMainWorktree(list.stdout)
    if (!repoRoot) {
      throw new Error(`could not determine the repo root for: ${req.worktreeDir}`)
    }

    // Refuse the repo's MAIN working tree: storing repoRoot === path would make
    // the task undeletable (assertSafeToDelete refuses candidate === repoRoot).
    if (canonPath(repoRoot) === canonPath(req.worktreeDir)) {
      throw new Error(
        'selected directory is the repository’s main working tree, not a linked worktree; create a new worktree instead'
      )
    }

    // Detect the current branch; `HEAD` means detached → no branch.
    const head = await this.runner.run(
      GIT,
      ['-C', req.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      {
        cwd: req.worktreeDir,
        env
      }
    )
    const headRef = firstNonEmptyLine(head.stdout).trim()
    const branch = head.exitCode === 0 && headRef !== '' && headRef !== 'HEAD' ? headRef : undefined

    return { path: canonPath(req.worktreeDir), repoRoot: canonPath(repoRoot), branch }
  }

  async remove(req: RemoveWorktreeRequest): Promise<void> {
    // Containment check BEFORE git runs (§6.4). Throws on any doubt.
    assertSafeToDelete({
      candidate: req.path,
      storedPath: req.path,
      repoRoot: req.repoDir
    })

    // `--force` only when the user confirmed a dirty delete: git refuses to remove
    // a worktree with uncommitted changes otherwise, which would strand the task
    // in DeleteFailed after the user already chose to delete it (§6.4).
    const args = ['-C', req.repoDir, 'worktree', 'remove', req.path]
    if (req.confirmedDirty === true) {
      args.push('--force')
    }

    // Resolve regardless of exit code (I4); spawn failure (ENOENT) still rejects.
    await this.runner.run(GIT, args, {
      cwd: req.repoDir,
      env: scriptEnv(req.taskId, req.repoDir)
    })
  }

  isDirty(worktreePath: string): Promise<boolean> {
    return gitIsDirty(this.runner, worktreePath)
  }
}
