/**
 * `listProjects` read query (DESIGN §5.4, §6.3). Pure read: lists every
 * configured project together with its live `taskCount` (how many of the
 * current tasks belong to it). Like `getSessionCwd`, it bypasses the
 * single-writer loop — it mutates no aggregate, so there's nothing to
 * serialize.
 *
 * Exports `taskMatchesProject`, which `use-cases/remove-project.ts` reuses for
 * its authoritative delete guard, so the sidebar's disabled-trash tooltip and
 * the actual block never drift apart.
 */

import type { AppDependencies } from '../dependencies'
import type { Task } from '../../domain/task'
import { canonProjectPath } from '../../domain/project-path'

export interface ProjectListItem {
  readonly path: string
  readonly defaultBranch?: string
  readonly taskCount: number
}

/**
 * True iff `task` belongs to the project at `projectPath`: not repo-less AND its
 * worktree's `repoRoot` canonically equals the project path (DESIGN "Task
 * link"). Guards against an empty/missing `repoRoot` spuriously matching an
 * empty `projectPath` — `canonProjectPath('')` is `''` for both, which would
 * otherwise compare equal.
 */
export function taskMatchesProject(task: Task, projectPath: string): boolean {
  if (task.repoLess) {
    return false
  }
  const repoRoot = task.worktree?.provisionedBy.repoRoot ?? ''
  if (repoRoot === '') {
    return false
  }
  return canonProjectPath(repoRoot) === canonProjectPath(projectPath)
}

export function listProjects(deps: AppDependencies): readonly ProjectListItem[] {
  const projects = deps.settings.load().projects ?? []
  const tasks = deps.workspace.tasks()
  return projects.map((project) => ({
    path: project.path,
    defaultBranch: project.defaultBranch,
    taskCount: tasks.filter((task) => taskMatchesProject(task, project.path)).length
  }))
}
