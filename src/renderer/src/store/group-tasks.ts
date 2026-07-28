/**
 * Pure helpers for the Progress panel's "group tasks by repo" view (§5.1). A task's
 * owning repository is its worktree's `provisionedBy.repoRoot` — the main checkout
 * dir captured at provision time. Grouping is a projection over the store's
 * `taskOrder`, so it stays consistent with drag-reorder and hydration.
 *
 * Kept dependency-free (accepts a minimal structural shape, not the full store)
 * so it is exhaustively unit-testable with no store/Electron bootstrapping.
 */

/** The minimal task shape the grouping needs: its id and (optional) repo root. */
export interface GroupableTask {
  readonly worktree?: { readonly provisionedBy?: { readonly repoRoot?: string } }
}

export interface TaskGroup {
  /** Absolute repo root; '' for the provisioning/no-repo bucket. */
  readonly repoRoot: string
  /** Header label: the repo dir basename, or 'Provisioning…' for the '' bucket. */
  readonly repoName: string
  /** Task ids in this group, in `taskOrder` order. */
  readonly taskIds: readonly string[]
}

/** Header shown for tasks with no worktree yet (Provisioning, invariant I1). */
export const NO_REPO_LABEL = 'Provisioning…'

/**
 * The last path segment of a repo root, tolerant of trailing separators and of
 * both POSIX (`/`) and Windows (`\`) separators. Returns the raw input if it has
 * no usable segment (e.g. '' or '/') so callers never render an empty header.
 */
export function repoBasename(repoRoot: string): string {
  const segments = repoRoot.split(/[\\/]+/).filter((s) => s.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : repoRoot
}

/** The repo key for one task: its worktree's repoRoot, or '' if not provisioned. */
export function repoKeyOf(task: GroupableTask | undefined): string {
  return task?.worktree?.provisionedBy?.repoRoot ?? ''
}

/**
 * Group `taskOrder` by owning repo. Groups appear in the order their first task
 * appears in `taskOrder` (so a user's drag-reorder predictably influences group
 * order); the no-repo bucket ('' key) is always appended LAST since provisioning
 * tasks are transient and shouldn't shuffle a stable repo header as they resolve.
 * Ids absent from `tasks` are skipped (mirrors the panel's `if (!t) return null`).
 */
export function groupTasksByRepo(
  taskOrder: readonly string[],
  tasks: Readonly<Record<string, GroupableTask>>
): readonly TaskGroup[] {
  const byRepo = new Map<string, string[]>()
  for (const id of taskOrder) {
    const task = tasks[id]
    if (!task) continue
    const key = repoKeyOf(task)
    const bucket = byRepo.get(key)
    if (bucket) bucket.push(id)
    else byRepo.set(key, [id])
  }

  const groups: TaskGroup[] = []
  for (const [repoRoot, taskIds] of byRepo) {
    if (repoRoot === '') continue // deferred to the end
    groups.push({ repoRoot, repoName: repoBasename(repoRoot), taskIds })
  }
  const noRepo = byRepo.get('')
  if (noRepo) groups.push({ repoRoot: '', repoName: NO_REPO_LABEL, taskIds: noRepo })
  return groups
}
