/**
 * `WorktreeProvider` backed by REPO-LOCAL user scripts (DESIGN §6.4). When a
 * task's chosen repo directory contains `create_worktree.sh` / `delete_worktree.sh`,
 * `SelectingWorktreeProvider` routes here. The script owns *where* the worktree
 * lives and returns its path; Octopus runs it through the argv-only
 * {@link ScriptRunner} (I17) and applies the §6.4 safety checks.
 *
 * `create`:
 *   - runs `<repoDir>/create_worktree.sh <sourceBranch> <newBranch>`, cwd = repoDir,
 *     env = OCTOPUS_REPO_ROOT (= repoDir) / OCTOPUS_TASK_ID / OCTOPUS_VERSION.
 *   - stderr is streamed as progress (§6.4 diagnostics → stderr); the FIRST
 *     non-empty stdout line is the worktree path.
 *   - non-zero exit / timeout / invalid path → reject (task not created).
 *
 * `remove`:
 *   - `assertSafeToDelete` runs BEFORE the script (containment, §6.4). The caller
 *     has already killed sessions and confirmed any dirty state.
 *   - runs `<repoDir>/delete_worktree.sh <taskName> <worktreePath>`; resolves even
 *     on non-zero exit — the task is removed regardless (I4) — but rejects (for a
 *     warning) when the script cannot be spawned.
 *
 * `isDirty`: `git -C <wt> status --porcelain` non-empty (§6.4), via the shared
 * helper.
 *
 * This adapter does NOT probe for the scripts' existence — the selector does that
 * and only constructs the invocation when the file is present. The create timeout
 * is read live from the injected settings getter.
 */

import { join } from 'node:path'
import type { Settings } from '../../ports/settings-store'
import type { ScriptRunner } from '../../ports/script-runner'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  AdoptWorktreeResult,
  RemoveWorktreeRequest,
  InspectRepoResult,
  RepoWorktree
} from '../../ports/worktree-provider'
import { validateWorktreePath, assertSafeToDelete, type PathProbe } from './path-safety'
import { deleteSafetyCanonicalizer, fsPathProbe } from './fs-path-probe'
import type { PathCanonical } from '../../shared/os'
import { scriptEnv, firstNonEmptyLine, firstLine, gitIsDirty } from './worktree-support'

/** The repo-local script file names the selector probes for (§6.4). */
export const CREATE_SCRIPT_NAME = 'create_worktree.sh'
export const DELETE_SCRIPT_NAME = 'delete_worktree.sh'

export interface ScriptWorktreeProviderDeps {
  readonly runner: ScriptRunner
  /** Live settings accessor (create timeout). */
  readonly getSettings: () => Settings
  /** Path probe for validation; defaults to the real fs probe. */
  readonly probe?: PathProbe
  /** Host profile's `fs.pathCanonical` (delete-safety path compares, §6.4). */
  readonly pathCanonical: PathCanonical
  /** Sink for the non-fatal "doesn't look like a worktree" warning (§6.4). */
  readonly onWarning?: (message: string) => void
}

export class ScriptWorktreeProvider implements WorktreeProvider {
  private readonly runner: ScriptRunner
  private readonly getSettings: () => Settings
  private readonly probe: PathProbe
  private readonly pathCanonical: PathCanonical
  private readonly onWarning?: (message: string) => void

  constructor(deps: ScriptWorktreeProviderDeps) {
    this.runner = deps.runner
    this.getSettings = deps.getSettings
    this.probe = deps.probe ?? fsPathProbe
    this.pathCanonical = deps.pathCanonical
    this.onWarning = deps.onWarning
  }

  async create(
    req: CreateWorktreeRequest,
    onProgress?: (line: string) => void
  ): Promise<CreateWorktreeResult> {
    const settings = this.getSettings()
    const script = join(req.repoDir, CREATE_SCRIPT_NAME)
    const args = [req.sourceBranch, req.newBranch]

    const result = await this.runner.run(script, args, {
      cwd: req.repoDir,
      env: scriptEnv(req.taskId, req.repoDir),
      timeoutMs: settings.worktreeCreateTimeoutMs,
      onStderrLine: onProgress
    })

    if (result.timedOut) {
      throw new Error(`create worktree script timed out: ${script}`)
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `create worktree script failed (exit ${result.exitCode ?? result.signal}): ${firstLine(result.stderr)}`
      )
    }

    const path = firstNonEmptyLine(result.stdout)
    const validation = validateWorktreePath(path, this.probe)
    if (!validation.ok) {
      throw new Error(validation.error)
    }
    if (validation.warning) {
      this.onWarning?.(validation.warning)
    }

    return { path: path.trim(), script, args }
  }

  /**
   * Adoption is git detection (repo root + branch), independent of any repo-local
   * script — `SelectingWorktreeProvider` always routes `adopt` to the native
   * provider (like `isDirty`), so this is never reached. Present only to satisfy
   * the port.
   */
  adopt(): Promise<AdoptWorktreeResult> {
    return Promise.reject(new Error('ScriptWorktreeProvider.adopt should never be called'))
  }

  async remove(req: RemoveWorktreeRequest): Promise<void> {
    const script = join(req.repoDir, DELETE_SCRIPT_NAME)
    // Containment check BEFORE invoking the script (§6.4). Throws on any doubt.
    assertSafeToDelete({
      candidate: req.path,
      storedPath: req.path,
      repoRoot: req.repoDir,
      canonical: deleteSafetyCanonicalizer(this.pathCanonical)
    })

    // Resolve regardless of exit code — the user asked to delete, so the record
    // is removed either way (I4). Spawn failure (ENOENT) still rejects.
    await this.runner.run(script, [req.taskName, req.path], {
      cwd: req.repoDir,
      env: scriptEnv(req.taskId, req.repoDir)
    })
  }

  isDirty(worktreePath: string): Promise<boolean> {
    return gitIsDirty(this.runner, worktreePath)
  }

  /**
   * Repo inspection is git detection, independent of any repo-local script —
   * `SelectingWorktreeProvider` always routes it to the native provider (like
   * `adopt`/`isDirty`), so this is never reached. Present only to satisfy the port.
   */
  inspectRepo(): Promise<InspectRepoResult> {
    return Promise.reject(new Error('ScriptWorktreeProvider.inspectRepo should never be called'))
  }

  /**
   * Same rationale as `inspectRepo` — always routed to native. Present only to
   * satisfy the port.
   */
  listWorktrees(): Promise<readonly RepoWorktree[]> {
    return Promise.reject(new Error('ScriptWorktreeProvider.listWorktrees should never be called'))
  }
}
