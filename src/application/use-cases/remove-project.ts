/**
 * `removeProject` use case (DESIGN §5.4, §6.3 "Delete"). Blocked while any task
 * still belongs to the project (`taskMatchesProject`, shared with
 * `queries/list-projects.ts`) — the sidebar disables the control, but this is
 * the authoritative re-check for a stale modal, so it returns `{ ok: false }`
 * rather than throwing. An unknown path is a no-op success (idempotent, the
 * same convention `deleteTask` uses for an already-gone task); otherwise the
 * filtered list is saved, which may become `[]`.
 */

import type { AppDependencies } from '../dependencies'
import type { RemoveProjectInput, CommandResult } from '../commands'
import { canonProjectPath } from '../../domain/project-path'
import { taskMatchesProject } from '../queries/list-projects'

export function removeProject(deps: AppDependencies, input: RemoveProjectInput): CommandResult {
  const projects = deps.settings.load().projects ?? []
  const canonTarget = canonProjectPath(input.path)
  const target = projects.find((p) => canonProjectPath(p.path) === canonTarget)
  if (!target) {
    // Idempotent: removing an already-gone project is a success.
    return { ok: true }
  }

  const matchCount = deps.workspace
    .tasks()
    .filter((task) => taskMatchesProject(task, target.path)).length
  if (matchCount > 0) {
    const message =
      matchCount === 1
        ? `Project has 1 task; delete it first`
        : `Project has ${matchCount} tasks; delete them first`
    return { ok: false, error: message }
  }

  deps.settings.save({
    projects: projects.filter((p) => canonProjectPath(p.path) !== canonTarget)
  })
  return { ok: true }
}
