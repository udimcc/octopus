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
 * Existing Repo" mode) — the freeze protects the not-yet-built V2 daemon
 * protocol, so widening the port before that binding exists is safe.
 *
 * `inspectRepo`/`listWorktrees` were added the same way, additively, for the
 * "defined projects" feature: a project is validated/resolved via `inspectRepo`
 * and its "From Existing Repo" picker is populated via `listWorktrees`.
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
   * The MAIN worktree / repo root that owns this worktree — or the picked
   * directory itself when the user adopts the repo's primary checkout. Stored as
   * the task's `repoRoot` for provenance; an adopted task is `managed === false`,
   * so `deleteTask` never removes it and `assertSafeToDelete` is never reached (§6.4).
   */
  readonly repoRoot: string
  /** Current branch of the worktree, if on one; `undefined` on detached HEAD. */
  readonly branch?: string
}

export interface InspectRepoResult {
  /**
   * Canonical path of the repo's main record: its main checkout, or the bare
   * directory for a bare repo (a linked worktree resolves here too).
   */
  readonly root: string
  /** Auto-detected default branch (`origin/HEAD`, else the current branch); `undefined` if neither resolves. */
  readonly defaultBranch?: string
}

export interface RepoWorktree {
  /** Canonical path of this worktree (main checkout or a linked one). */
  readonly path: string
  /** Branch checked out there; `undefined` on detached HEAD. */
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
   * Adopt an EXISTING repo directory ("From Existing Repo", §6.4). Detects the
   * owning repo root and current branch via git; validates the directory the same
   * way as a created path. Rejects if the directory is not a git worktree. The
   * repo's MAIN working tree is allowed: the resulting task is unmanaged, so
   * deleting it leaves the directory on disk rather than removing it.
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

  /**
   * Validate `dir` as a git repository and resolve it to its main record — its
   * main checkout, or the bare directory for a bare repo — plus an auto-detected
   * default branch, for "add project" (§6.4). Accepts a working tree, a linked
   * worktree or a bare directory; rejects anything else.
   */
  inspectRepo(dir: string): Promise<InspectRepoResult>

  /**
   * The repo's worktrees (main checkout + linked ones), for the "From Existing
   * Repo" picker once a project is chosen (§6.4). `root` is expected to already be
   * a main record (as returned by `inspectRepo`). Rejects on a non-zero git exit.
   */
  listWorktrees(root: string): Promise<readonly RepoWorktree[]>
}
