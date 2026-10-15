/**
 * `importJiraIssues` use case (DESIGN "Jira import"). Creates a local `Issue`
 * (source `Jira`, status `Todo`, no `projectPath`) for each selected fetched
 * `JiraIssue` that is actually new, skipping the rest.
 *
 * Re-classifies every input issue against the workspace's CURRENT issues —
 * never trusts the modal's earlier `previewJiraIssues` snapshot, since the
 * workspace may have changed since (another import, a manual delete) — and
 * additionally skips a key repeated WITHIN the input itself (second and later
 * occurrences), so a duplicate checkbox selection can't create two local
 * issues for the same Jira key in one batch.
 *
 * Persists before mutating in-memory state (mirrors `create-issue.ts`): every
 * `upsertIssue` runs inside ONE `deps.persistence.transaction`, and only once
 * it returns (i.e. commits) does this touch `Workspace`/`EventBus` — exactly
 * mirroring `create-issue.ts`'s ordering, just batched. A throw inside the
 * transaction propagates up to the command loop (`DomainError`/generic catch,
 * `command-loop.ts`), which turns it into `{ ok: false, error }`; nothing
 * before that point has mutated `Workspace` or published anything, so the
 * rollback is implicit from ordering alone, not an explicit undo.
 */

import type { AppDependencies } from '../dependencies'
import type { ImportJiraIssuesInput, CommandResult } from '../commands'
import type { Issue as IssueDomain } from '../../domain/issue'
import type { IssueSnapshot } from '../../domain/snapshots'
import { Issue, IssueSource } from '../../domain/issue'
import { composeJiraIssue, classifyJiraIssue } from '../../domain/jira-import'

export function importJiraIssues(
  deps: AppDependencies,
  input: ImportJiraIssuesInput
): CommandResult {
  const existingIssues = deps.workspace.issues()
  const seenKeys = new Set<string>()
  const skippedKeys: string[] = []
  const now = deps.clock.now()

  const toCreate: Array<{ readonly issue: IssueDomain; readonly snapshot: IssueSnapshot }> = []

  for (const jiraIssue of input.issues) {
    if (seenKeys.has(jiraIssue.key)) {
      // Same key requested twice in this batch — only the first occurrence
      // gets a chance to import; later ones are skipped outright.
      skippedKeys.push(jiraIssue.key)
      continue
    }
    seenKeys.add(jiraIssue.key)

    const composed = composeJiraIssue(jiraIssue)
    const classification = classifyJiraIssue(composed, jiraIssue.key, existingIssues)
    if (classification.kind !== 'new') {
      skippedKeys.push(jiraIssue.key)
      continue
    }

    const issue = Issue.create({
      id: deps.ids.newIssueId(),
      name: composed.name,
      description: composed.description,
      // -1 ms per created issue keeps the batch in fetched order under the list's
      // newest-first sort — with one shared timestamp it would fall back to the random id.
      createdAt: now - toCreate.length,
      source: IssueSource.Jira,
      jiraKey: jiraIssue.key
    })
    toCreate.push({ issue, snapshot: issue.toSnapshot() })
  }

  deps.persistence.transaction(() => {
    for (const { snapshot } of toCreate) {
      deps.persistence.upsertIssue(snapshot)
    }
  })

  for (const { issue, snapshot } of toCreate) {
    deps.workspace.addIssue(issue)
    deps.bus.publish({ type: 'issueUpserted', issue: snapshot })
  }

  return { ok: true, importedCount: toCreate.length, skippedKeys }
}
