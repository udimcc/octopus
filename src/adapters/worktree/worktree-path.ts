/**
 * Pure worktree-path computation for the native git provider (DESIGN §6.4).
 * Mirrors the pure-resolver split of `env/paths.ts`: no filesystem access, so it
 * is exhaustively unit-testable. Only `NativeGitWorktreeProvider` uses this — the
 * repo-local `create_worktree.sh` owns its own path and returns it on stdout.
 *
 * Layout is FLAT (per the resolved design): every native worktree is a direct
 * child of the configured base dir `worktree.location`, named
 * `<sanitized-new-branch>-<short-task-id>`. The task-id suffix guarantees
 * uniqueness (I6) even when two tasks request the same branch name, and keeps the
 * base dir a shallow, browsable list of worktrees rather than a nested tree.
 */

import { join } from 'node:path'

/** How many chars of the task id to append for uniqueness (matches §6.4 sample). */
const SHORT_ID_LEN = 8

/**
 * Turn a branch name into a safe single path segment. Branch names may contain
 * `/` (namespacing, e.g. `feature/x`), spaces, and other characters that would
 * either nest the worktree or be awkward on disk — collapse every run of
 * non-`[a-z0-9]` (case-insensitive) into a single `-` and trim stray dashes.
 * `'feature/Add Thing'` → `'feature-Add-Thing'`. An all-separator branch (e.g.
 * `'///'`) sanitizes to `''`; the caller still appends the id suffix so the
 * segment is never empty.
 */
export function sanitizeBranchForDir(branch: string): string {
  return branch
    .replace(/[^a-zA-Z0-9]+/g, '-') // any run of non-alphanumerics → single dash
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
}

export interface ComputeWorktreePathInput {
  /** Resolved absolute base dir (`worktree.location`), e.g. `~/octopus_repos`. */
  readonly base: string
  /** The new branch the worktree is for (from the New-Task modal). */
  readonly newBranch: string
  /** The task's id; its short prefix suffixes the dir name for uniqueness (I6). */
  readonly taskId: string
}

/**
 * Compute the absolute path for a native-git worktree: a flat child of `base`
 * named `<sanitized-new-branch>-<short-task-id>`. Pure — the caller ensures
 * `base` exists (`ensureWorktreeBase`) and validates the result post-`git`.
 */
export function computeWorktreePath({ base, newBranch, taskId }: ComputeWorktreePathInput): string {
  const shortId = taskId.slice(0, SHORT_ID_LEN)
  const branchPart = sanitizeBranchForDir(newBranch)
  // A blank branch part would yield a leading dash; drop it so the dir is just
  // the id in that (degenerate) case.
  const dirName = branchPart.length > 0 ? `${branchPart}-${shortId}` : shortId
  return join(base, dirName)
}
