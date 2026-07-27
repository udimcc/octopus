/**
 * Port for provisioning/removing git worktrees (DESIGN §6.4). The V1 provider
 * behind this port (`SelectingWorktreeProvider`) picks, per task, between a
 * repo-local user script (`create_worktree.sh`/`delete_worktree.sh` in the task's
 * `repoDir`) and Octopus running `git worktree` itself under a configured base
 * dir. Either way the resulting path is stored verbatim (§6.4).
 *
 * The interface SHAPE is frozen across versions (§10); only the request payloads
 * gain fields (`repoDir`/`sourceBranch`/`newBranch`) as the modal supplies them.
 * `adopt` was added additively during V1 development (the modal grew a "From
 * Existing Worktree" mode) — the freeze protects the not-yet-built V2 daemon
 * protocol, so widening the port before that binding exists is safe.
 */

import type { TaskId } from '../domain/ids'

export interface CreateWorktreeRequest {
  readonly taskId: TaskId
  /** Display name (available to scripts via $OCTOPUS env; used for diagnostics). */
  readonly taskName: string
  /** The task's chosen repository directory (from the New-Task modal, §5.4). */
  readonly repoDir: string
  /** Branch the worktree is created FROM (first positional arg to the script). */
  readonly sourceBranch: string
  /** Branch the worktree is created ON (second positional arg to the script). */
  readonly newBranch: string
}

export interface CreateWorktreeResult {
  /** Absolute worktree path (first non-empty stdout line), validated by caller. */
  readonly path: string
  /** The command that was run (script path or `git`), for provenance. */
  readonly script: string
  readonly args: readonly string[]
}

export interface AdoptWorktreeRequest {
  readonly taskId: TaskId
  /** Display name (available to diagnostics; symmetric with create). */
  readonly taskName: string
  /** The existing worktree directory the user selected in the modal. */
  readonly worktreeDir: string
}

export interface AdoptWorktreeResult {
  /** The adopted worktree path (validated, absolute) — stored as the session cwd. */
  readonly path: string
  /**
   * The MAIN worktree / repo root that owns this worktree. Stored as the task's
   * `repoRoot` so a later delete points git (or `delete_worktree.sh`) at the repo,
   * and so `assertSafeToDelete` sees a `path` distinct from `repoRoot` (§6.4).
   */
  readonly repoRoot: string
  /** Current branch of the worktree, if on one; `undefined` on detached HEAD. */
  readonly branch?: string
}

export interface RemoveWorktreeRequest {
  readonly taskId: TaskId
  readonly taskName: string
  /** The stored worktree path (passed to the delete script/git verbatim, §6.4). */
  readonly path: string
  /** The task's repository directory (where the delete script / git runs, §6.4). */
  readonly repoDir: string
  /** The user confirmed deleting a dirty worktree → native git gets `--force`. */
  readonly confirmedDirty?: boolean
}

export interface WorktreeProvider {
  /**
   * Provision the worktree (repo-local script or native git, §6.4); stream
   * diagnostics via `onProgress`. Rejects if the script/git fails or the
   * resulting path fails validation (§6.4).
   */
  create(
    req: CreateWorktreeRequest,
    onProgress?: (line: string) => void
  ): Promise<CreateWorktreeResult>

  /**
   * Adopt an EXISTING worktree directory (§6.4). Detects the owning repo root and
   * current branch via git; validates the directory the same way as a created
   * path. Rejects if the directory is not a git worktree, or if it is the repo's
   * MAIN working tree (adopting the primary checkout would make the task
   * undeletable — delete would target the repo itself).
   */
  adopt(req: AdoptWorktreeRequest): Promise<AdoptWorktreeResult>

  /**
   * Remove the worktree (repo-local script or native git, §6.4). The caller kills
   * sessions and runs the dirty gate BEFORE calling; the provider re-checks path
   * containment. Resolves even on non-zero exit — the task record is removed
   * regardless (I4) — but rejects when the script/git cannot be spawned.
   */
  remove(req: RemoveWorktreeRequest): Promise<void>

  /** True iff the worktree has uncommitted changes (`git status --porcelain`, §6.4). */
  isDirty(worktreePath: string): Promise<boolean>
}
