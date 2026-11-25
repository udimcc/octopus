/**
 * Worktree path safety (DESIGN §6.4). Pure functions (a filesystem probe is
 * injected), so every refusal is exhaustively unit-testable. Octopus is
 * location-agnostic — it does NOT constrain where a worktree lives — so these
 * checks are deliberately minimal and structural, not policy:
 *
 *  - `validateWorktreePath` (used after CREATE): the returned path must be
 *    absolute, exist, and be a directory (§6.4 "validates minimally"). A
 *    non-git-looking path yields a non-fatal warning, never a rejection.
 *
 *  - `assertSafeToDelete` (used before DELETE): the candidate must be EXACTLY the
 *    path stored for this task, be absolute, and be neither `/`, nor the repo
 *    root, nor an ancestor of the repo root — so a delete script can never be
 *    aimed at the repo or the filesystem root (§6.4).
 *
 * These guard the trust boundary alongside the argv-only runner (I17): even a
 * correctly-invoked delete script is only ever pointed at a contained path.
 */

import { isAbsolute, normalize, sep } from 'node:path'

/** Minimal filesystem probe the validator needs; real impl wraps `fs.statSync`. */
export interface PathProbe {
  /** True iff `path` exists and is a directory. */
  isDirectory(path: string): boolean
  /** True iff `path`/.git exists (marks a git worktree; advisory only). */
  looksLikeGitWorktree(path: string): boolean
}

export interface ValidationResult {
  readonly ok: boolean
  /** Present when `ok` is false: why the path was rejected. */
  readonly error?: string
  /** Present when `ok` is true but the path doesn't look like a worktree (§6.4). */
  readonly warning?: string
}

/**
 * Validate a create script's returned path (§6.4). Rejects only on the three
 * hard requirements; a missing `.git` is a warning, not a rejection, because
 * Octopus does not constrain worktree location.
 */
export function validateWorktreePath(raw: string, probe: PathProbe): ValidationResult {
  const path = raw.trim()
  if (path.length === 0) {
    return { ok: false, error: 'create script returned no worktree path on stdout' }
  }
  if (!isAbsolute(path)) {
    return { ok: false, error: `worktree path is not absolute: ${path}` }
  }
  if (!probe.isDirectory(path)) {
    return { ok: false, error: `worktree path does not exist or is not a directory: ${path}` }
  }
  if (!probe.looksLikeGitWorktree(path)) {
    return { ok: true, warning: `path does not look like a git worktree (no .git): ${path}` }
  }
  return { ok: true }
}

export interface DeleteSafetyInput {
  /** The path the delete script would be pointed at. */
  readonly candidate: string
  /** The path stored verbatim for this task at create time (§6.4). */
  readonly storedPath: string
  /** $OCTOPUS_REPO_ROOT for this task. */
  readonly repoRoot: string
  /**
   * Maps a path to the form the structural guards compare (applied to both the
   * candidate and the repo root, after normalization). Absent → identity, which
   * is the Linux behavior. On macOS the real wrapper (`fsCanonicalPath`) resolves
   * symlinks (`/tmp` → `/private/tmp`) and case-folds (APFS is case-insensitive
   * by default) so `/Users/u/Repo` can't slip past the repo-root guard when git
   * reports `/Users/u/repo`. Folding only ever adds refusals.
   */
  readonly canonical?: (path: string) => string
}

/**
 * Throw unless it is safe to run the delete script against `candidate` (§6.4).
 * Order matters: identity with the stored path first (the strongest guarantee),
 * then the structural guards against `/`, the repo root, and repo-root ancestors.
 */
export function assertSafeToDelete({
  candidate,
  storedPath,
  repoRoot,
  canonical
}: DeleteSafetyInput): void {
  if (!isAbsolute(candidate)) {
    throw new Error(`refusing to delete non-absolute path: ${candidate}`)
  }
  if (candidate !== storedPath) {
    throw new Error(
      `refusing to delete a path that differs from the stored worktree path (${candidate} !== ${storedPath})`
    )
  }
  const c = canon(candidate, canonical)
  if (c === sep) {
    throw new Error('refusing to delete the filesystem root')
  }
  const root = canon(repoRoot, canonical)
  if (c === root) {
    throw new Error(`refusing to delete the repo root: ${candidate}`)
  }
  // An ancestor of the repo root (e.g. deleting `/home/u` when repo is
  // `/home/u/repo`) would take the repo with it.
  if (isAncestor(c, root)) {
    throw new Error(`refusing to delete an ancestor of the repo root: ${candidate}`)
  }
}

/** Normalize and strip a single trailing separator (but keep root `/`). */
function canon(p: string, canonical?: (path: string) => string): string {
  const n = trimSep(normalize(p))
  return canonical ? trimSep(normalize(canonical(n))) : n
}

function trimSep(n: string): string {
  if (n.length > 1 && n.endsWith(sep)) {
    return n.slice(0, -1)
  }
  return n
}

/** True iff `ancestor` is a strict path-prefix of `descendant` at a segment boundary. */
function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) {
    return false
  }
  const prefix = ancestor === sep ? sep : ancestor + sep
  return descendant.startsWith(prefix)
}
