/**
 * `seedProjects` use case (DESIGN §6.3 "Seeding", refinements). A one-shot,
 * best-effort boot seed: runs ONLY while `settings.json`'s `projects` key is
 * absent (`undefined` — never `[]`, which means the user emptied it on
 * purpose, §6.3). Collects the distinct repo roots of existing non-"No Repo"
 * tasks (in first-seen order), resolves each with `inspectRepo` — a repo that
 * no longer exists on disk, or any other rejection, is silently skipped — and
 * dedupes on the CANONICAL resolved root, so a task whose stored `repoRoot`
 * was a linked worktree collapses into its main record.
 *
 * Saves NOTHING when there are no candidates (no tasks, or every `inspectRepo`
 * call rejected): a fresh/unconfigured install must not create `settings.json`
 * (see the comment on `JsonSettingsStore.load`). The `projects` key then stays
 * absent, so a later boot (once a task exists) still gets a chance to seed.
 *
 * **Also saves nothing when `settings.loadFailed()` is true** (DESIGN §6.3): an
 * absent `projects` key is ambiguous between "genuinely never seeded" and "the
 * real file on disk is unreadable/malformed, so `load()` returned defaults and
 * we don't actually know what's in it" — `loadFailed()` (the `SettingsStore`
 * port) distinguishes the two. Seeding in the second case would silently
 * overwrite a user's broken-but-recoverable file with defaults plus the seed.
 * Each of these skips (and "no candidates") resolves the command
 * loop's `execute()` to `{ ok: true }` — a deliberate, silent no-op, not an
 * error (no logger port is wired into `AppDependencies`, so this use case has
 * no way to log one anyway). A genuinely unexpected throw (e.g. from
 * `deps.settings`/`deps.workspace`, as opposed to a per-repo `inspectRepo`
 * rejection, which is caught and skipped below) is a different story: `execute`
 * turns it into `{ ok: false, error }`, and the composition root's `.then`
 * around the dispatch does `console.warn` that case.
 */

import type { AppDependencies } from '../dependencies'
import type { ProjectSettings } from '../../ports/settings-store'
import { canonProjectPath } from '../../domain/project-path'

export async function seedProjects(deps: AppDependencies): Promise<void> {
  const settings = deps.settings.load()
  if (settings.projects !== undefined) {
    return
  }
  if (deps.settings.loadFailed()) {
    return
  }

  // Distinct repo roots across non-repo-less tasks, first-seen order.
  const repoRoots: string[] = []
  for (const task of deps.workspace.tasks()) {
    const repoRoot = task.worktree?.provisionedBy.repoRoot
    if (task.repoLess || !repoRoot || repoRoots.includes(repoRoot)) {
      continue
    }
    repoRoots.push(repoRoot)
  }

  const seenRoots = new Set<string>()
  const projects: ProjectSettings[] = []
  for (const repoRoot of repoRoots) {
    try {
      const inspected = await deps.worktrees.inspectRepo(repoRoot)
      const canonRoot = canonProjectPath(inspected.root)
      if (seenRoots.has(canonRoot)) {
        continue
      }
      seenRoots.add(canonRoot)
      projects.push({ path: inspected.root, defaultBranch: inspected.defaultBranch })
    } catch {
      // Unresolvable (deleted/moved repo) — skip; the user can "+ Add project" later.
    }
  }

  if (projects.length === 0) {
    return
  }
  deps.settings.save({ projects })
}
