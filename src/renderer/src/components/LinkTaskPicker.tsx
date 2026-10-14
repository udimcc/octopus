/**
 * Small modal listing every task so `IssueDetail`'s "Link task" button can bind
 * the current issue to one of them (PRD "Issues" → binding is 1:1 and replaces
 * either side's existing binding; `issues.bind` enforces that, so picking a task
 * here never needs a confirmation prompt first).
 *
 * A task already bound to a DIFFERENT issue is disabled ("already linked") —
 * `issueForTask` is the same reverse lookup the task row icon and the New-Task
 * modal's issue picker use. A task that isn't persisted yet (`provisioning`) or
 * failed to provision (`provision_failed`) is disabled too: there is nothing
 * meaningful to link to until (or unless) it reaches `ready`. The task already
 * bound to THIS issue is marked "current" rather than disabled — rebinding it is a
 * harmless no-op.
 *
 * Tasks are grouped by project exactly like the Progress panel's grouped view
 * (`groupTasksByRepo`: repo groups in first-appearance order, then "No Repository",
 * then the transient Provisioning bucket), so the user finds a task under the same
 * header they see in the task list.
 *
 * No backdrop blur/filter (VMware VDI / SwiftShader, no GPU) — same plain dim as
 * every other modal in this codebase.
 *
 * Portaled to `document.body`: mounted deep inside the Issues
 * drawer, whose slide-in CSS `transform` becomes the *containing block* for a
 * `position: fixed` descendant — without the portal, this dialog's full-viewport
 * backdrop would be confined to the drawer's own bounds, leaving the Progress panel
 * clickable right through it. `createPortal` only moves the raw DOM placement; React
 * event bubbling (so `onClick`/`onKeyDown`'s `stopPropagation`) is unaffected.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/store'
import { groupTasksByRepo, NO_REPOSITORY_KEY } from '../store/group-tasks'
import { overlayStyle, modalCardStyle, color, fontSize, radius } from '../style/tokens'
import { cleanIpcError } from '../util/ipc-error'
import type { IssueDTO } from '../../../shared/dto'

export interface LinkTaskPickerProps {
  readonly issueId: string
  readonly onClose: () => void
}

export function LinkTaskPicker({ issueId, onClose }: LinkTaskPickerProps): React.JSX.Element {
  const taskOrder = useStore((s) => s.taskOrder)
  const tasks = useStore((s) => s.tasks)
  const issues = useStore((s) => s.issues)

  // taskId → bound issue, built once per `issues` change rather than re-scanning
  // every issue for every task row on every render — the equivalent of
  // `issueForTask`, but computed once for the whole list instead of per task.
  const issueByTaskId = useMemo(() => {
    const map = new Map<string, IssueDTO>()
    for (const issue of Object.values(issues)) {
      if (issue.taskId !== undefined) map.set(issue.taskId, issue)
    }
    return map
  }, [issues])

  const groups = useMemo(() => groupTasksByRepo(taskOrder, tasks), [taskOrder, tasks])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = (taskId: string): void => {
    setBusy(true)
    setError(null)
    void window.octopusAPI.issues.bind({ issueId, taskId }).then(
      (ack) => {
        setBusy(false)
        if (!ack.ok) {
          setError(ack.error ?? 'Failed to link task')
          return
        }
        onClose()
      },
      (err: unknown) => {
        setBusy(false)
        setError(cleanIpcError(err))
      }
    )
  }

  return createPortal(
    <div role="presentation" onClick={busy ? undefined : onClose} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Link task"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) onClose()
        }}
        style={{ ...modalCardStyle, width: 420 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Link task</h2>

        {taskOrder.length === 0 ? (
          <p style={{ margin: 0, color: color.muted }}>No tasks yet.</p>
        ) : (
          <ul
            role="listbox"
            aria-label="Tasks"
            style={{ margin: 0, padding: 0, listStyle: 'none', maxHeight: 400, overflowY: 'auto' }}
          >
            {groups.map((g) => (
              <li
                key={g.repoRoot || 'provisioning'}
                role="group"
                aria-label={g.repoName}
                style={{ listStyle: 'none' }}
              >
                <div
                  style={{
                    padding: '8px 10px 4px',
                    color: color.muted,
                    fontSize: fontSize.sm,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={g.repoRoot && g.repoRoot !== NO_REPOSITORY_KEY ? g.repoRoot : g.repoName}
                >
                  {g.repoName}
                </div>
                <ul style={{ margin: 0, padding: 0 }}>
                  {g.taskIds.map((taskId) => {
                    const task = tasks[taskId]
                    if (!task) return null
                    const boundIssue = issueByTaskId.get(taskId)
                    const isCurrent = boundIssue?.id === issueId
                    const boundElsewhere = boundIssue !== undefined && !isCurrent
                    // `none` (not yet provisioned at all) is grayed as not-ready too, same
                    // as mid-provisioning or failed — none of the three have a
                    // worktree yet to link to.
                    const notReady =
                      task.lifecycle === 'none' ||
                      task.lifecycle === 'provisioning' ||
                      task.lifecycle === 'provision_failed'
                    const disabled = boundElsewhere || notReady || busy
                    const suffix = isCurrent
                      ? 'current'
                      : boundElsewhere
                        ? 'already linked'
                        : notReady
                          ? `(${task.lifecycle})`
                          : ''
                    return (
                      <li key={taskId} style={{ listStyle: 'none' }}>
                        <button
                          type="button"
                          className="menu-item"
                          role="option"
                          aria-selected={isCurrent}
                          aria-disabled={disabled}
                          disabled={disabled}
                          onClick={() => pick(taskId)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            width: '100%',
                            padding: '6px 10px 6px 18px', // indented under its project header
                            textAlign: 'left',
                            background: 'transparent',
                            border: 'none',
                            borderRadius: radius.sm
                          }}
                        >
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {task.name}
                          </span>
                          {suffix ? (
                            <span
                              style={{
                                color: color.muted,
                                fontSize: fontSize.sm,
                                flexShrink: 0,
                                marginLeft: 8
                              }}
                            >
                              {suffix}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" style={{ margin: 0, color: color.errorText }}>
            {error}
          </p>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" autoFocus onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
