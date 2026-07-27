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

import type { Settings } from '../../ports/settings-store'
import type { ScriptRunner } from '../../ports/script-runner'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  RemoveWorktreeRequest
} from '../../ports/worktree-provider'
import { validateWorktreePath, assertSafeToDelete, type PathProbe } from './path-safety'
import { fsPathProbe } from './fs-path-probe'
import { computeWorktreePath } from './worktree-path'
import { GIT, scriptEnv, firstLine, gitIsDirty } from './worktree-support'

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
