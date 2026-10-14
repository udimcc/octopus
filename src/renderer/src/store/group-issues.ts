/**
 * Pure grouping for the Issues drawer's issue list ("Issues"). Issues are grouped by
 * status in a fixed order (Todo, In progress, In review, Done — all four always
 * present, even empty, so the list can render stable collapsible headers), newest
 * first within each group.
 *
 * Kept dependency-free beyond the shared DTO so it is exhaustively unit-testable with
 * no store/Electron bootstrapping.
 */

import type { IssueDTO, IssueStatusDTO } from '../../../shared/dto'
import { ISSUE_STATUS_ORDER } from './issue-status'

/** One status bucket of the issue list, in list order. */
export interface IssueGroup {
  readonly status: IssueStatusDTO
  readonly issues: readonly IssueDTO[]
}

/**
 * Group `issues` by status in the canonical {@link ISSUE_STATUS_ORDER} (Todo, In
 * progress, In review, Done). Every status appears, possibly with an empty `issues`
 * array, so the UI always has a group to render a (collapsible) header for. Within a
 * group, issues sort newest first by `createdAt`; ties break on `id` (ascending) so
 * the order is deterministic even when two issues share a millisecond timestamp.
 */
export function groupIssuesByStatus(issues: readonly IssueDTO[]): readonly IssueGroup[] {
  const byStatus = new Map<IssueStatusDTO, IssueDTO[]>()
  for (const status of ISSUE_STATUS_ORDER) byStatus.set(status, [])
  for (const issue of issues) {
    byStatus.get(issue.status)?.push(issue)
  }

  return ISSUE_STATUS_ORDER.map((status) => ({
    status,
    issues: [...(byStatus.get(status) ?? [])].sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }))
}
