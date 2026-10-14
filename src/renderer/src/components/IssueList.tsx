/**
 * The Issues drawer's left pane: the full issue list grouped by status (PRD "Issues"
 * → "Issues window"; DESIGN §13.5). Self-contained — reads `issues`/`selectedIssueId`/
 * `issueDraft` from the store directly and dispatches `selectIssue`/`startNewIssue`
 * itself, the same way `ProgressPanel` is the task list's own store-reading
 * container; there is no intermediate presentational layer here (unlike
 * `TaskListItem`/`ProjectSidebar`) because the drawer has no sibling that also needs
 * this data.
 *
 * Each status group is collapsible — local, unpersisted state, since there's nothing
 * worth remembering across sessions. **Done** starts collapsed per the PRD. Group
 * order and newest-first-within-group come from `groupIssuesByStatus`.
 */

import { useState } from 'react'
import { useStore } from '../store/store'
import { groupIssuesByStatus } from '../store/group-issues'
import { repoBasename } from '../store/group-tasks'
import { IssueStatusIcon, ISSUE_STATUS_LABELS } from './IssueStatusIcon'
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

/** A small chain-link mark for the row's linked-task chip (inline SVG, like the
 * status icons — no host font has a ⛓ glyph outside the color-emoji font). */
function LinkGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: '-0.125em' }}
    >
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  )
}

export function IssueList(): React.JSX.Element {
  const issues = useStore((s) => s.issues)
  const tasks = useStore((s) => s.tasks)
  const selectedIssueId = useStore((s) => s.selectedIssueId)
  const issueDraft = useStore((s) => s.issueDraft)
  const selectIssue = useStore((s) => s.selectIssue)
  const startNewIssue = useStore((s) => s.startNewIssue)

  // Done starts collapsed (PRD "Issues window"); local, unpersisted.
  const [collapsed, setCollapsed] = useState<Readonly<Record<IssueStatusDTO, boolean>>>({
    todo: false,
    in_progress: false,
    in_review: false,
    done: true
  })

  const groups = groupIssuesByStatus(Object.values(issues))

  const toggleGroup = (status: IssueStatusDTO): void => {
    setCollapsed((prev) => ({ ...prev, [status]: !prev[status] }))
  }

  return (
    <div
      style={{
        // Wide enough for real issue names; capped so the detail pane keeps room on a
        // narrow window.
        width: 660,
        maxWidth: '50%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: `1px solid ${color.border}`,
        overflowY: 'auto'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: `1px solid ${color.borderSubtle}`
        }}
      >
        <button
          type="button"
          className="btn-primary"
          style={{ fontSize: fontSize.sm, padding: '2px 10px' }}
          onClick={startNewIssue}
        >
          + New Issue
        </button>
      </div>

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
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  color: color.text,
                                  fontWeight: selected ? 600 : 500
                                }}
                              >
                                {issue.name}
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
