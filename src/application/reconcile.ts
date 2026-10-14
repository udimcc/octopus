/**
 * Startup reconciliation (DESIGN §6.3 Restore, §7 I14). After `Workspace.hydrate`
 * rebuilds tasks from persistence — every reloaded task is `Ready`, every session
 * a fresh `Created` definition (I13, mappers.ts) — this walks each task and checks
 * its worktree still exists on disk:
 *
 *   - **Missing / not a directory** → `markStale` + emit `taskStale`, and do NOT
 *     start any of its sessions (I14). A Stale task offers re-provision or
 *     force-forget in the UI.
 *   - **Present** → leave it `Ready`. Its session DEFINITIONS are kept, but their
 *     PTYs are NOT started here: runtimes start LAZILY on first `TaskView`
 *     activation (bounds the startup PTY count — a workspace with many tasks does
 *     not fork every shell at launch). V1 opens a fresh PTY at the worktree cwd
 *     when a session first becomes visible (§6.3 "open a fresh PTY").
 *
 * Runs on the single writer during bootstrap, before the command loop accepts any
 * user command, so no mutation races reconciliation (§6.6).
 *
 * `existsDir` is injected (the `fs/dir-exists` adapter) to keep this use-case
 * free of node/fs imports and unit-testable with a fake probe.
 */

import type { AppDependencies } from './dependencies'
import type { WorkspaceSnapshot } from '../domain/snapshots'
import type { GroupId } from '../domain/ids'
import { TaskLifecycle } from '../domain/lifecycle'

export interface ReconcileProbe {
  /** True iff `path` exists AND is a directory (never throws). */
  existsDir(path: string): boolean
}

export function reconcileOnStartup(deps: AppDependencies, probe: ReconcileProbe): void {
  for (const task of deps.workspace.tasks()) {
    // Only a Ready task carries a worktree to verify; a hydrated task is always
    // Ready (mappers reconstruct it so), but guard defensively.
    if (task.lifecycle !== TaskLifecycle.Ready) {
      continue
    }
    const worktree = task.worktree
    if (!worktree) {
      continue
    }

    if (!probe.existsDir(worktree.path)) {
      task.markStale()
      deps.bus.publish({ type: 'taskStale', taskId: task.id })
    }
  }
}

/**
 * Sweep `session_groups` rows that `Task.fromSnapshot`/`restoreGroups` rejected
 * at hydrate (review I1): an unknown/duplicate leaf, fewer than 2 surviving
 * members, members split across windows, non-contiguous tabs, or a tree that
 * failed to parse/validate (DESIGN §5.7 "loading tolerates bad saved data") — a
 * row whose JSON itself fails to parse still reaches `raw` with its real id
 * (`mappers.ts`'s `rowToGroupSnapshot` carries it through as a single-leaf
 * marker tree, which `restoreGroups` rejects same as any other invalid tree —
 * see that function's own doc), so this sweep can still find and delete it.
 * Those rows are never written to `restored`, so nothing in the normal
 * group-mutation path (which only ever upserts/deletes groups it KNOWS about,
 * via `persistGroups`) ever reaches them again — left alone, a dropped row sits
 * in the table forever and could later win a duplicate-leaf race against a
 * brand-new, valid group, or silently "revive" if the sessions it references
 * are ever recreated with the same ids.
 *
 * `raw` is the pre-hydrate `WorkspaceSnapshot` (persistence's own read, before
 * `Workspace.hydrate` dropped anything) — the only place the FULL as-persisted
 * group id list is still available, since `Task` never kept the rejects. The
 * diff against each live task's SURVIVING `groups()` is exactly the dropped
 * set. Deletes run in one transaction; call this once, right after hydrate,
 * before the command loop accepts any user command (same ordering guarantee
 * `reconcileOnStartup` relies on, §6.6).
 */
export function reconcileStaleGroups(deps: AppDependencies, raw: WorkspaceSnapshot): void {
  const staleIds: GroupId[] = []
  for (const taskSnap of raw.tasks) {
    const task = deps.workspace.task(taskSnap.id)
    const survivingIds = new Set(task ? task.groups().map((g) => g.id) : [])
    for (const g of taskSnap.groups ?? []) {
      if (!survivingIds.has(g.id)) {
        staleIds.push(g.id)
      }
    }
  }
  if (staleIds.length === 0) {
    return
  }
  deps.persistence.transaction(() => {
    for (const id of staleIds) {
      deps.persistence.deleteGroup(id)
    }
  })
}
