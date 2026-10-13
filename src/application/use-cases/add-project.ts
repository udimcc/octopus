/**
 * `addProject` use case (DESIGN §5.4, §6.3, §6.4 "Add flow"). "+ Add project" in
 * the New-Task modal: resolves the picked directory to its repo's main record
 * via `inspectRepo` — which also rejects a non-git directory — and appends it to
 * `settings.json`'s `projects`. If a project already exists for that canonical
 * root (including the case where the user picked one of its LINKED worktrees,
 * which `inspectRepo` resolves back to the same main record), the existing
 * entry is returned unchanged and nothing is saved — "add" never duplicates.
 *
 * An `inspectRepo` rejection (not a git repo) is left to PROPAGATE as a thrown
 * error rather than being caught here: the command loop's `execute()` already
 * turns any thrown error into `{ ok: false, error }`, so there is no need for a
 * second, local `ok: false` path for this one failure mode.
 */

import type { AppDependencies } from '../dependencies'
import type { AddProjectInput, CommandResult } from '../commands'
import type { ProjectSettings } from '../../ports/settings-store'
import { canonProjectPath } from '../../domain/project-path'

export async function addProject(
  deps: AppDependencies,
  input: AddProjectInput
): Promise<CommandResult> {
  const inspected = await deps.worktrees.inspectRepo(input.dir)
  const canonRoot = canonProjectPath(inspected.root)

  const projects = deps.settings.load().projects ?? []
  const existing = projects.find((p) => canonProjectPath(p.path) === canonRoot)
  if (existing) {
    // Already configured — select it instead of duplicating; settings.json is
    // untouched.
    return { ok: true, project: existing }
  }

  const project: ProjectSettings = { path: inspected.root, defaultBranch: inspected.defaultBranch }
  deps.settings.save({ projects: [...projects, project] })
  return { ok: true, project }
}
