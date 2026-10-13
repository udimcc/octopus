/**
 * `listProjectWorktrees` read query (DESIGN §5.4, §6.4 "Existing Repo flow").
 * Lists a project's main checkout + linked worktrees for the New-Task modal's
 * "From Existing Repo" picker, annotating each with the name of the task
 * currently using it (if any) so the modal can disable that row. Like
 * `getSessionCwd`, this bypasses the single-writer loop — a pure read of live
 * `WorktreeProvider`/workspace state that mutates no aggregate — and is async
 * because `listWorktrees` shells out to git.
 */

import type { AppDependencies } from '../dependencies'
import { canonProjectPath } from '../../domain/project-path'

export interface ProjectWorktreeItem {
  readonly path: string
  readonly branch?: string
  /** Name of the task whose worktree is this path, if any (drives the disabled row). */
  readonly usedByTaskName?: string
}

export async function listProjectWorktrees(
  deps: AppDependencies,
  projectPath: string
): Promise<readonly ProjectWorktreeItem[]> {
  const worktrees = await deps.worktrees.listWorktrees(projectPath)
  const tasks = deps.workspace.tasks()

  return worktrees.map((wt) => {
    const canonWtPath = canonProjectPath(wt.path)
    const usedBy = tasks.find(
      (task) => task.worktree && canonProjectPath(task.worktree.path) === canonWtPath
    )
    return { path: wt.path, branch: wt.branch, usedByTaskName: usedBy?.name }
  })
}
