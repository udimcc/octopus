import { useEffect, useRef } from 'react'

/**
 * Scrolls the selected issue's row/card into view, shared by `IssueList` and
 * `KanbanBoard` (DESIGN §13.5's selection-follow: a tab opening on an already
 * selected issue, or the task-row icon landing on one, scrolls it into view).
 *
 * Re-follows whenever `selectedIssueId`, `isOpen` or `issueStatus` changes — the
 * last so a selection that arrives before its issue has loaded (a create ack
 * landing before the matching `issueUpserted`) still gets followed once it does,
 * even though `selectedIssueId` itself didn't change. `issueStatus` must be a
 * primitive (the selected issue's own `status`, or `undefined` while unloaded/
 * unselected) so it only flips when that actually happens, not on every unrelated
 * store update.
 *
 * `onReady`, if given, runs first on every attempt and can return `false` to defer
 * (e.g. `IssueList` asking a collapsed group to expand first); having no
 * dependency array of its own, the second effect below retries on every
 * subsequent commit, so it picks up that expand once it lands — but only while a
 * follow for the CURRENT `selectedIssueId` is still pending (`pendingRef`). Once a
 * follow completes (or `onReady` is omitted), it's marked done, so an unrelated
 * render — e.g. the user later re-collapsing that same group by hand — is a no-op
 * rather than fighting that choice.
 */
export function useFollowSelectedIssue(
  containerRef: React.RefObject<HTMLElement | null>,
  isOpen: boolean,
  selectedIssueId: string | undefined,
  issueStatus: string | undefined,
  onReady?: () => boolean
): void {
  const pendingRef = useRef<string | undefined>(undefined)

  // A genuine new thing to follow: arm it. (Re-)runs only on an actual
  // selection/open/load change — never on caller-local state like a collapsed
  // group, which the effect below retries without needing to know about it.
  useEffect(() => {
    pendingRef.current = selectedIssueId
  }, [selectedIssueId, isOpen, issueStatus])

  // Deliberately no dependency array: this must retry after a commit caused by
  // `onReady`'s own side effect (e.g. expanding a group), and `pendingRef` below
  // makes re-running on every commit a cheap no-op once there's nothing pending.
  useEffect(() => {
    if (!isOpen || !selectedIssueId || !issueStatus) return
    if (pendingRef.current !== selectedIssueId) return
    if (onReady && !onReady()) return
    pendingRef.current = undefined
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-issue-id="${CSS.escape(selectedIssueId)}"]`
    )
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  })
}
