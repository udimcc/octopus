/**
 * The `WorktreeProvider` wired into the composition root (DESIGN §6.4, §10). It
 * composes two focused adapters behind the single unchanged port and picks
 * between them PER CALL by probing the task's repo directory:
 *
 *   - `<repoDir>/create_worktree.sh` exists → delegate `create` to the
 *     {@link ScriptWorktreeProvider} (the repo owns provisioning).
 *   - otherwise → delegate to the {@link NativeGitWorktreeProvider} (Octopus runs
 *     git under the configured base dir).
 *
 * Detection is per-call, not per-construction: different tasks target different
 * repos, some with custom scripts and some without (§6.4). `remove` probes for
 * `delete_worktree.sh` symmetrically. `isDirty` is provider-neutral (`git status`)
 * so it delegates to one implementation regardless of the create path taken.
 *
 * The probe is injected (`existsFile`) so the dispatch logic is unit-testable
 * without touching the filesystem.
 */

import { join } from 'node:path'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  RemoveWorktreeRequest
} from '../../ports/worktree-provider'
import { CREATE_SCRIPT_NAME, DELETE_SCRIPT_NAME } from './script-worktree-provider'

/** Probes whether a repo-local script file exists (real impl: `existsFile`). */
export type ScriptProbe = (path: string) => boolean

export interface SelectingWorktreeProviderDeps {
  /** Handles repos that ship `create_worktree.sh` / `delete_worktree.sh`. */
  readonly script: WorktreeProvider
  /** Handles script-less repos (Octopus runs `git worktree`). */
  readonly native: WorktreeProvider
  /** True iff the given path is an existing file (repo-local script probe). */
  readonly hasScript: ScriptProbe
}

export class SelectingWorktreeProvider implements WorktreeProvider {
  private readonly script: WorktreeProvider
  private readonly native: WorktreeProvider
  private readonly hasScript: ScriptProbe

  constructor(deps: SelectingWorktreeProviderDeps) {
    this.script = deps.script
    this.native = deps.native
    this.hasScript = deps.hasScript
  }

  create(
    req: CreateWorktreeRequest,
    onProgress?: (line: string) => void
  ): Promise<CreateWorktreeResult> {
    const provider = this.hasScript(join(req.repoDir, CREATE_SCRIPT_NAME))
      ? this.script
      : this.native
    return provider.create(req, onProgress)
  }

  remove(req: RemoveWorktreeRequest): Promise<void> {
    const provider = this.hasScript(join(req.repoDir, DELETE_SCRIPT_NAME))
      ? this.script
      : this.native
    return provider.remove(req)
  }

  isDirty(worktreePath: string): Promise<boolean> {
    // Provider-neutral (`git status --porcelain`); either delegate is equivalent.
    return this.native.isDirty(worktreePath)
  }
}
