/**
 * `createIssue` use case (DESIGN "Issues" §13.3, PRD "Issues"). Creates a new,
 * unbound issue in `Todo` (or the caller's `status`). Mirrors `addProject`'s
 * canonical-path matching for `projectPath`: an unconfigured path is rejected
 * (`{ ok: false }`) rather than silently stored, since nothing else re-validates
 * it later (unlike a task's `repoRoot`, which the worktree itself anchors).
 *
 * `Issue.create` owns the name invariant (trims, rejects an empty name) — a throw
 * here surfaces as `{ ok: false }` via the command loop's `DomainError` catch,
 * before anything is persisted or added to the workspace.
 *
 * Persists before mutating in-memory state: if `upsertIssue` throws, the
 * workspace is left exactly as it was (no issue added), rather than holding an
 * issue in memory that was never written to disk.
 */

import type { AppDependencies } from '../dependencies'
import type { CreateIssueInput, CommandResult } from '../commands'
import { Issue } from '../../domain/issue'
import { canonProjectPath } from '../../domain/project-path'

export function createIssue(deps: AppDependencies, input: CreateIssueInput): CommandResult {
  let projectPath: string | undefined
  if (input.projectPath !== undefined) {
    const projects = deps.settings.load().projects ?? []
    const canonTarget = canonProjectPath(input.projectPath)
    const match = projects.find((p) => canonProjectPath(p.path) === canonTarget)
    if (!match) {
      return { ok: false, error: `Unknown project: ${input.projectPath}` }
    }
    projectPath = match.path
  }

  const id = deps.ids.newIssueId()
  const now = deps.clock.now()
  // Domain validation (trims, rejects an empty name) — a throw here surfaces as
  // `{ ok: false }` via the command loop's `DomainError` catch, before any write.
  const issue = Issue.create({
    id,
    name: input.name,
    description: input.description,
    projectPath,
    createdAt: now
  })
  if (input.status !== undefined) {
    issue.setStatus(input.status)
  }

  const snapshot = issue.toSnapshot()
  deps.persistence.upsertIssue(snapshot)
  deps.workspace.addIssue(issue)
  deps.bus.publish({ type: 'issueUpserted', issue: snapshot })
  return { ok: true, issueId: id }
}
