/**
 * `removeProject` use case (DESIGN §5.4, §6.3 "Delete"). Blocked while any task
 * still belongs to the project (`taskMatchesProject`, shared with
 * `queries/list-projects.ts`) — the sidebar disables the control, but this is
 * the authoritative re-check for a stale modal, so it returns `{ ok: false }`
 * rather than throwing. An unknown path is a no-op success (idempotent, the
 * same convention `deleteTask` uses for an already-gone task); otherwise the
 * filtered list is saved, which may become `[]`.
 *
 * **Issue cleanup ("Issues" §13.3, I19).** Unlike tasks, issues never block
 * project removal. The cleared snapshots are computed WITHOUT mutating
 * `Workspace` yet and persisted (one transaction) BEFORE `settings.save`: if
 * persistence fails, nothing else has happened — Settings still lists the
 * project and `Workspace` still has the old `projectPath`s, which is harmless.
 * If `settings.save` itself throws AFTER that DB commit, the issue rows would
 * otherwise be left pointing at a project Settings no longer lists; the
 * `catch` re-upserts the ORIGINAL (pre-clear) snapshots in their own
 * transaction before rethrowing, so the DB rolls back in step with Settings —
 * `Workspace` is never touched in this failure path, since the in-memory clear
 * only happens below, after `settings.save` succeeds. Only once both the
 * persist and the settings save have succeeded does `workspace.clearIssueProject`
 * apply the same clear in memory, and each changed issue is announced via
 * `issueUpserted`. `updatedAt` is deliberately left unchanged: this is a
 * cascading side-effect of removing the project from Settings, not a user edit
 * to the issue itself — the same convention `deleteTask` uses for an
 * unbind-without-touch.
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

  // Issues never block project removal (unlike tasks): compute the cleared
  // snapshots WITHOUT mutating `Workspace` yet, so a persistence failure here
  // leaves everything — including Settings, saved further below — untouched.
  const affectedIssues = deps.workspace
    .issues()
    .filter(
      (issue) =>
        issue.projectPath !== undefined && canonProjectPath(issue.projectPath) === canonTarget
    )
  const originalSnapshots = affectedIssues.map((issue) => issue.toSnapshot())
  const changedSnapshots = originalSnapshots.map((snapshot) => ({
    ...snapshot,
    projectPath: undefined
  }))
  if (changedSnapshots.length > 0) {
    deps.persistence.transaction(() => {
      for (const snapshot of changedSnapshots) {
        deps.persistence.upsertIssue(snapshot)
      }
    })
  }

  try {
    deps.settings.save({
      projects: projects.filter((p) => canonProjectPath(p.path) !== canonTarget)
    })
  } catch (err) {
    // Settings didn't actually drop the project; undo the DB clear above so
    // persistence doesn't disagree with Settings (`Workspace` was never
    // mutated in this path, so there is nothing to restore there).
    if (changedSnapshots.length > 0) {
      deps.persistence.transaction(() => {
        for (const snapshot of originalSnapshots) {
          deps.persistence.upsertIssue(snapshot)
        }
      })
    }
    throw err
  }

  // Only now mirror the clear into the in-memory issues, matching what was
  // just persisted and saved.
  deps.workspace.clearIssueProject(target.path)
  for (const snapshot of changedSnapshots) {
    deps.bus.publish({ type: 'issueUpserted', issue: snapshot })
  }

  return { ok: true }
}
