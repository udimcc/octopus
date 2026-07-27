/**
 * Port for provisioning/removing git worktrees (DESIGN §6.4). The V1 provider
 * behind this port (`SelectingWorktreeProvider`) picks, per task, between a
 * repo-local user script (`create_worktree.sh`/`delete_worktree.sh` in the task's
 * `repoDir`) and Octopus running `git worktree` itself under a configured base
 * dir. Either way the resulting path is stored verbatim (§6.4).
 *
 * The interface SHAPE is frozen across versions (§10); only the request payloads
 * gain fields (`repoDir`/`sourceBranch`/`newBranch`) as the modal supplies them.
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
   * Remove the worktree (repo-local script or native git, §6.4). The caller kills
   * sessions and runs the dirty gate BEFORE calling; the provider re-checks path
   * containment. Resolves even on non-zero exit — the task record is removed
   * regardless (I4) — but rejects when the script/git cannot be spawned.
   */
  remove(req: RemoveWorktreeRequest): Promise<void>

  /** True iff the worktree has uncommitted changes (`git status --porcelain`, §6.4). */
  isDirty(worktreePath: string): Promise<boolean>
}
