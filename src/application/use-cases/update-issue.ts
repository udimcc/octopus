/**
 * `updateIssue` use case (DESIGN "Issues" §13). Patches `name`/`description`/
 * `projectPath`/`status`; only fields present on the input change —
 * `projectPath: null` explicitly clears the project, `undefined`/omitted leaves
 * it as is (mirrors `UpdateIssueInput`'s own doc comment).
 *
 * The project patch is resolved (and, for a non-null path, validated against
 * `settings.projects` the same way `createIssue` does) BEFORE any mutation, and
 * `rename` — the only setter that can throw (an empty name) — runs first among
 * the mutations themselves. Together that ordering guarantees a rejected patch
 * (unknown project, or empty name) never touches `upsertIssue` at all: a thrown
 * `InvariantViolationError` surfaces before persistence is even attempted.
 *
 * The mutations themselves run in memory before `upsertIssue` (capture-before /
 * restore-after, mirroring `bind-issue.ts`): we capture every field's prior
 * value first, so if `upsertIssue` itself throws (e.g. a disk error, not a
 * validation rejection), the mutations are undone and `Workspace` is restored to
 * exactly its pre-call state instead of diverging from what's on disk.
 */

import type { AppDependencies } from '../dependencies'
import type { UpdateIssueInput, CommandResult } from '../commands'
import { canonProjectPath } from '../../domain/project-path'

export function updateIssue(deps: AppDependencies, input: UpdateIssueInput): CommandResult {
  const issue = deps.workspace.issue(input.issueId)
  if (!issue) {
    return { ok: false, error: `issue ${input.issueId} not found` }
  }

  const patchesProject = input.projectPath !== undefined
  let nextProjectPath: string | undefined
  if (patchesProject && input.projectPath !== null) {
    const projects = deps.settings.load().projects ?? []
    const canonTarget = canonProjectPath(input.projectPath)
    const match = projects.find((p) => canonProjectPath(p.path) === canonTarget)
    if (!match) {
      return { ok: false, error: `Unknown project: ${input.projectPath}` }
    }
    nextProjectPath = match.path
  }

  // Capture prior values so a persistence failure below can be rolled back.
  const prior = {
    name: issue.name,
    description: issue.description,
    projectPath: issue.projectPath,
    status: issue.status,
    updatedAt: issue.updatedAt
  }

  // The only mutation that can throw (empty name) — do it first so a rejection
  // never leaves description/project/status partially applied, and never
  // reaches `upsertIssue` below.
  if (input.name !== undefined) {
    issue.rename(input.name)
  }
  if (patchesProject) {
    issue.setProject(nextProjectPath)
  }
  if (input.description !== undefined) {
    issue.setDescription(input.description)
  }
  if (input.status !== undefined) {
    issue.setStatus(input.status)
  }
  issue.touch(deps.clock.now())

  const snapshot = issue.toSnapshot()
  try {
    deps.persistence.upsertIssue(snapshot)
  } catch (err) {
    // Restore every field directly from the capture above — `prior.name` was
    // already valid (it was the issue's own name a moment ago), so `rename`
    // here cannot throw.
    issue.rename(prior.name)
    issue.setProject(prior.projectPath)
    issue.setDescription(prior.description)
    issue.setStatus(prior.status)
    issue.touch(prior.updatedAt)
    throw err
  }
  deps.bus.publish({ type: 'issueUpserted', issue: snapshot })
  return { ok: true }
}
