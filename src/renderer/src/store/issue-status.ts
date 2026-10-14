/**
 * Canonical issue-status table ("Issues"). The fixed display order (Todo → In
 * progress → In review → Done) and the display label for each status are defined
 * ONCE here and sourced by every consumer that needs them: `group-issues.ts`'s
 * drawer grouping, `IssueStatusIcon`'s glyph/status `<select>` labels (re-exported
 * from there so existing imports keep working), and the New-Task modal's issue
 * picker. Before this module existed, `group-issues.ts` and `IssueStatusIcon.tsx`
 * each declared their own copy of the same four-value order, which could silently
 * drift apart.
 *
 * Lives in the store layer, not a component, so a dependency-free module like
 * `group-issues.ts` (exhaustively unit-testable with no component/Electron
 * bootstrapping) can import it without pulling in `IssueStatusIcon.tsx`.
 */

import type { IssueStatusDTO } from '../../../shared/dto'

/** Fixed display order (Todo → In progress → In review → Done). */
export const ISSUE_STATUS_ORDER: readonly IssueStatusDTO[] = [
  'todo',
  'in_progress',
  'in_review',
  'done'
]

/** Status → display label, for the status `<select>` and other text UI. */
export const ISSUE_STATUS_LABELS: Readonly<Record<IssueStatusDTO, string>> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done'
}
