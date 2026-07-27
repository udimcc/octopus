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
