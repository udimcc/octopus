/**
 * `setProjectDefaultBranch` use case (DESIGN §5.4, §6.3). Inline edit on the
 * project row: a trimmed-empty value clears `defaultBranch` back to
 * `undefined` (so "Source branch" no longer prefills on that project); an
 * unknown path returns an error, since — unlike `removeProject` — there is no
 * sensible no-op to fall back to for an edit.
 */

import type { AppDependencies } from '../dependencies'
import type { SetProjectDefaultBranchInput, CommandResult } from '../commands'
import { canonProjectPath } from '../../domain/project-path'

export function setProjectDefaultBranch(
  deps: AppDependencies,
  input: SetProjectDefaultBranchInput
): CommandResult {
  const projects = deps.settings.load().projects ?? []
  const canonTarget = canonProjectPath(input.path)
  if (!projects.some((p) => canonProjectPath(p.path) === canonTarget)) {
    return { ok: false, error: `Unknown project: ${input.path}` }
  }

  const trimmed = input.defaultBranch?.trim()
  const nextDefaultBranch = trimmed === undefined || trimmed === '' ? undefined : trimmed

  deps.settings.save({
    projects: projects.map((p) =>
      canonProjectPath(p.path) === canonTarget ? { ...p, defaultBranch: nextDefaultBranch } : p
    )
  })
  return { ok: true }
}
