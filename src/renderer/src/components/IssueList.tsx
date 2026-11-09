/**
 * The Issues drawer's left pane: the full issue list grouped by status (PRD "Issues"
 * → "Issues window"; DESIGN §13.5). Self-contained — reads `issues`/`selectedIssueId`/
 * `issueDraft` from the store directly and dispatches `selectIssue` itself, the same
 * way `ProgressPanel` is the task list's own store-reading container; there is no
 * intermediate presentational layer here (unlike `TaskListItem`/`ProjectSidebar`)
 * because the drawer has no sibling that also needs this data.
 *
 * Each status group is collapsible — local, unpersisted state, since there's nothing
 * worth remembering across sessions. **Done** starts collapsed per the PRD. Group
 * order and newest-first-within-group come from `groupIssuesByStatus`.
 *
 * This is the drawer's List-tab pane (`IssuesDrawer` renders it, or `KanbanBoard`, from
 * the store's `issuesDrawerTab`, and unmounts whichever one isn't active) — fills the
 * drawer width next to the fixed-share `IssueDetail` pane. **+ New Issue** lives in the
 * drawer's own header (shared with the Board tab), not here; a tab switch unmounts
 * this component, so the collapsed-group state above resets (Done starts collapsed
 * again) — acceptable since nothing here is persisted anyway.
 *
 * **Selection follow (DESIGN §13.5):** whenever `selectedIssueId` changes — including
 * on mount, e.g. right after switching from the Board tab, or the task-row icon
 * (`TaskListItem`) opening straight onto this tab with an issue already selected — a
 * collapsed group holding that issue expands, then its row scrolls into view. Shared
 * with `KanbanBoard` via `useFollowSelectedIssue`; here the hook's `onReady` callback
 * expands the group (returning `false` until it has), and `collapsed`/`issues` are
 * read from the closure rather than declared as dependencies, so a group the user
 * deliberately (re-)collapses while the SAME issue stays selected is never re-touched —
 * this only reacts to an actual selection change, the drawer re-opening, or the issue
 * finishing loading.
 */

import { useRef, useState } from 'react'
import { useStore } from '../store/store'
import { groupIssuesByStatus } from '../store/group-issues'
import { repoBasename } from '../store/group-tasks'
import { useFollowSelectedIssue } from '../hooks/useFollowSelectedIssue'
import { IssueStatusIcon, ISSUE_STATUS_LABELS, LinkGlyph } from './IssueStatusIcon'
import { color, fontSize, radius } from '../style/tokens'
import type { IssueStatusDTO } from '../../../shared/dto'

/**
 * A one-line plain-text teaser of a markdown description for the row's second line:
 * the first non-blank line, with the leading block markers (`#`, `>`, list bullets,
 * task boxes) and inline emphasis/code/link punctuation dropped. Not a markdown
 * parser — a row preview only needs to be readable, not exact.
 */
export function descriptionPreview(markdown: string): string {
  const line = markdown.split('\n').find((l) => l.trim() !== '') ?? ''
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
}

export function IssueList(): React.JSX.Element {
  const issues = useStore((s) => s.issues)
  const tasks = useStore((s) => s.tasks)
  const selectedIssueId = useStore((s) => s.selectedIssueId)
  const issueDraft = useStore((s) => s.issueDraft)
  const selectIssue = useStore((s) => s.selectIssue)
  const issuesDrawerOpen = useStore((s) => s.issuesDrawerOpen)

  // Done starts collapsed (PRD "Issues window"); local, unpersisted.
  const [collapsed, setCollapsed] = useState<Readonly<Record<IssueStatusDTO, boolean>>>({
    todo: false,
    in_progress: false,
    blocked: false,
    in_review: false,
    done: true
  })

  const groups = groupIssuesByStatus(Object.values(issues))

  const toggleGroup = (status: IssueStatusDTO): void => {
    setCollapsed((prev) => ({ ...prev, [status]: !prev[status] }))
  }

  const containerRef = useRef<HTMLDivElement>(null)

  // See the class doc comment ("Selection follow"). Guarded on `issuesDrawerOpen`,
  // same reasoning as `KanbanBoard`'s own copy of this guard: while the drawer is
  // closed it is merely translated off-screen via CSS `transform` — still mounted
  // (DESIGN §13.5) — so a row inside it isn't somewhere worth scrolling into view
  // yet; deferred until the drawer is actually open, which `useFollowSelectedIssue`
  // re-runs for once it is, since `isOpen` is one of its own triggers.
  const selectedIssue = selectedIssueId ? issues[selectedIssueId] : undefined
  useFollowSelectedIssue(
    containerRef,
    issuesDrawerOpen,
    selectedIssueId,
    selectedIssue?.status,
    () => {
      if (!selectedIssue) return false
      if (!collapsed[selectedIssue.status]) return true
      setCollapsed((prev) => ({ ...prev, [selectedIssue.status]: false }))
      return false
    }
  )

  return (
    <div
      ref={containerRef}
      style={{
        // Fills its `IssuesDrawer`-owned `role="tabpanel"` wrapper (which carries the
        // single border against the fixed-share `IssueDetail` pane next to it, and
        // `minWidth: 0` so this can actually shrink that far); this div itself only
        // needs to scroll.
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto'
      }}
    >
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', flex: 1 }}>
        {groups.map((group) => {
          const isCollapsed = collapsed[group.status]
          return (
            <li key={group.status} style={{ listStyle: 'none' }}>
              <button
                type="button"
                className="issue-group-header"
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroup(group.status)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '6px 12px',
                  border: 'none',
                  borderRadius: 0,
                  color: color.textSecondary,
                  fontSize: fontSize.sm,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  cursor: 'pointer'
                }}
              >
                <span>
                  {isCollapsed ? '▸' : '▾'} {ISSUE_STATUS_LABELS[group.status]}
                </span>
                <span style={{ color: color.muted }}>{group.issues.length}</span>
              </button>

              {!isCollapsed ? (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {group.issues.length === 0 ? (
                    <li
                      style={{
                        padding: '4px 12px',
                        color: color.muted,
                        fontSize: fontSize.sm,
                        listStyle: 'none'
                      }}
                    >
                      None
                    </li>
                  ) : (
                    group.issues.map((issue) => {
                      const selected = !issueDraft && issue.id === selectedIssueId
                      const preview = descriptionPreview(issue.description)
                      const linkedTask = issue.taskId ? tasks[issue.taskId] : undefined
                      return (
                        <li key={issue.id} style={{ listStyle: 'none', padding: '1px 8px' }}>
                          <button
                            type="button"
                            className="issue-row"
                            data-issue-id={issue.id}
                            aria-pressed={selected}
                            onClick={() => selectIssue(issue.id)}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 10,
                              width: '100%',
                              padding: '8px 10px',
                              // Unselected background (transparent + hover tint) lives in `.issue-row`'s CSS:
                              // an inline value would override the `:hover` rule.
                              background: selected ? color.bgSelected : undefined,
                              color: selected ? color.text : color.textSecondary,
                              boxShadow: selected ? `inset 3px 0 0 ${color.accent}` : 'none',
                              border: 'none',
                              borderRadius: radius.md,
                              textAlign: 'left',
                              cursor: 'pointer'
                            }}
                          >
                            <span style={{ display: 'inline-flex', paddingTop: 2 }}>
                              <IssueStatusIcon status={issue.status} size={14} />
                            </span>
                            <span
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 2,
                                flex: 1,
                                minWidth: 0
                              }}
                            >
                              <span
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  minWidth: 0
                                }}
                              >
                                <span
                                  style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    minWidth: 0,
                                    flex: '1 1 auto',
                                    color: color.text,
                                    fontWeight: selected ? 600 : 500
                                  }}
                                >
                                  {issue.name}
                                </span>
                                {issue.source === 'jira' ? (
                                  <span
                                    className="issue-row-jira-badge"
                                    title={issue.jiraKey}
                                    style={{
                                      flexShrink: 0,
                                      padding: '0 5px',
                                      border: `1px solid ${color.border}`,
                                      borderRadius: radius.pill,
                                      color: color.textSecondary,
                                      fontSize: fontSize.sm,
                                      lineHeight: '1.4em'
                                    }}
                                  >
                                    Jira
                                  </span>
                                ) : null}
                              </span>
                              {preview ? (
                                <span
                                  className="issue-row-preview"
                                  style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    color: color.muted,
                                    fontSize: fontSize.sm
                                  }}
                                >
                                  {preview}
                                </span>
                              ) : null}
                            </span>
                            {issue.projectPath || linkedTask ? (
                              <span
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  flexShrink: 0,
                                  maxWidth: '45%',
                                  fontSize: fontSize.sm
                                }}
                              >
                                {issue.projectPath ? (
                                  <span
                                    className="issue-row-project"
                                    title={issue.projectPath}
                                    style={{
                                      padding: '0 6px',
                                      border: `1px solid ${color.border}`,
                                      borderRadius: radius.pill,
                                      color: color.textSecondary,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap'
                                    }}
                                  >
                                    {repoBasename(issue.projectPath)}
                                  </span>
                                ) : null}
                                {linkedTask ? (
                                  <span
                                    className="issue-row-task"
                                    title={`Linked task: ${linkedTask.name}`}
                                    style={{
                                      color: color.accent,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap'
                                    }}
                                  >
                                    <LinkGlyph /> {linkedTask.name}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      )
                    })
                  )}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
