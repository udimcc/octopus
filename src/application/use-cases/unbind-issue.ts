/**
 * `unbindIssue` use case (DESIGN "Issues" §13.3, I19). Clears the issue's task
 * binding; status is left unchanged (unbinding never auto-transitions status,
 * unlike binding's `Todo` → `InProgress`). A missing issue is `{ ok: false }`
 * rather than idempotent-`ok`, UNLIKE `deleteIssue`: unbind targets one issue by
 * id for an explicit "disconnect" action on an issue the UI believes exists, so
 * a missing id signals a stale view, not a routine re-delete.
 *
 * Persists before mutating in-memory state (mirrors `create-issue`/`delete-issue`):
 * the unbound snapshot is computed without touching the domain object yet, so a
 * persistence failure leaves `Workspace` exactly as it was instead of diverging
 * from disk. `updatedAt` is deliberately left untouched — unbinding is not an
 * edit to the issue's own content.
 */

import type { AppDependencies } from '../dependencies'
import type { UnbindIssueInput, CommandResult } from '../commands'

export function unbindIssue(deps: AppDependencies, input: UnbindIssueInput): CommandResult {
  const issue = deps.workspace.issue(input.issueId)
  if (!issue) {
    return { ok: false, error: `issue ${input.issueId} not found` }
  }

  const snapshot = { ...issue.toSnapshot(), taskId: undefined }
  deps.persistence.upsertIssue(snapshot)
  deps.workspace.unbindIssue(input.issueId)
  deps.bus.publish({ type: 'issueUpserted', issue: snapshot })
  return { ok: true }
}
