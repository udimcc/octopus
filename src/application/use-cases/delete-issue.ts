/**
 * `deleteIssue` use case (DESIGN "Issues" §13.3). Removes the issue from
 * persistence and the workspace and publishes `issueDeleted`. Idempotent —
 * deleting an already-gone issue is a success with no event, mirroring
 * `deleteTask`'s and `removeProject`'s convention for a target that no longer
 * exists. The bound task, if any, is left untouched: deleting an issue never
 * touches `Task` (unlike deleting a TASK, which unbinds its issue — see
 * `Workspace.removeTask`).
 *
 * Persists before mutating in-memory state: if `deleteIssue` throws, the issue
 * stays in the workspace exactly as it was, rather than vanishing from memory
 * while still on disk.
 */

import type { AppDependencies } from '../dependencies'
import type { DeleteIssueInput, CommandResult } from '../commands'

export function deleteIssue(deps: AppDependencies, input: DeleteIssueInput): CommandResult {
  const issue = deps.workspace.issue(input.issueId)
  if (!issue) {
    // Idempotent: deleting an already-gone issue is a success.
    return { ok: true }
  }

  deps.persistence.deleteIssue(input.issueId)
  deps.workspace.removeIssue(input.issueId)
  deps.bus.publish({ type: 'issueDeleted', issueId: input.issueId })
  return { ok: true }
}
