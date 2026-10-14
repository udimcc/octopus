/**
 * One task row in the `ProgressPanel` list (DESIGN §5.1/§5.4). Clicking activates
 * the task (`setActiveTask` locally + `tasks.switch` to the backend), double-click
 * renames it in place (`tasks.rename`), and the row is a dnd-kit sortable handle so
 * tasks reorder by dragging (`tasks.reorder`, reconciled by `taskReordered`).
 *
 * The row leads with the task's aggregate status icon (§5.4, §9) — the max-priority
 * roll-up over its sessions' display levels (`taskDisplayState`, folding state and
 * ready-for-review, §3.4/§9.5), computed by the panel and passed in. When not `ready`
 * it also shows a "(lifecycle)" suffix so provisioning/stale/failed states stay legible.
 *
 * A task bound to an issue (PRD "Issues" → "On the task side") also shows the issue's
 * `IssueStatusIcon`, title = the issue name, as a nested `<button>`: clicking it opens
 * the Issues drawer on that issue WITHOUT activating the task (`openIssuesDrawer`,
 * `e.stopPropagation()` so the row's own `onClick` never fires), and `onPointerDown`
 * also stops propagation so dnd-kit's `PointerSensor` (bound via `listeners` on the
 * row below) never starts a drag from it. `useSortable` is wired with only a
 * `PointerSensor` (no `KeyboardSensor`), so `listeners` carries no `onKeyDown`
 * activator today — nothing to stop propagation of there, so none is added.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EditableLabel } from './EditableLabel'
import { StatusIcon } from './StatusIcon'
import { IssueStatusIcon } from './IssueStatusIcon'
import { useStore, issueForTask } from '../store/store'
import { color, fontSize } from '../style/tokens'
import type { DisplayState } from '../store/display-state'
import type { TaskEntry } from '../store/store'

export interface TaskListItemProps {
  readonly task: TaskEntry
  readonly active: boolean
  readonly onActivate: () => void
  readonly onRename: (name: string) => void
  /** The resolved rollup display level for this task (§3.4/§9.5). */
  readonly display: DisplayState
  /** Indent the row under a repo header in the grouped view (§5.1). */
  readonly indent?: boolean
}

export function TaskListItem({
  task,
  active,
  onActivate,
  onRename,
  display,
  indent = false
}: TaskListItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id
  })
  // Narrow selector (DESIGN §Issues "On the task side"): `issueForTask` returns the
  // SAME issue object reference across unrelated store updates, so this row only
  // re-renders when ITS binding or the bound issue itself actually changes, not on
  // every store change.
  const boundIssue = useStore((s) => issueForTask(s, task.id))
  const openIssuesDrawer = useStore((s) => s.openIssuesDrawer)

  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    textAlign: 'left',
    padding: indent ? '7px 12px 7px 24px' : '7px 12px',
    background: active ? color.bgSelected : 'transparent',
    color: active ? color.text : color.textSecondary,
    boxShadow: active ? `inset 2px 0 0 ${color.accent}` : 'none',
    cursor: 'pointer',
    boxSizing: 'border-box'
  }

  return (
    <li ref={setNodeRef} style={{ listStyle: 'none' }}>
      <div
        {...attributes}
        {...listeners}
        className="task-row"
        role="button"
        aria-pressed={active}
        aria-label={task.name}
        onClick={onActivate}
        style={rowStyle}
      >
        <span
          style={{ display: 'inline-flex', width: 16, justifyContent: 'center', marginRight: 6 }}
        >
          <StatusIcon display={display} />
        </span>
        <EditableLabel
          value={task.name}
          onCommit={onRename}
          editAriaLabel="rename task"
          style={{ flex: 1, minWidth: 0 }}
        />
        {boundIssue ? (
          <button
            type="button"
            aria-label={`Open issue ${boundIssue.name}`}
            title={boundIssue.name}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              openIssuesDrawer(boundIssue.id)
            }}
            style={{
              marginLeft: 6,
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'inline-flex'
            }}
          >
            <IssueStatusIcon status={boundIssue.status} title={boundIssue.name} />
          </button>
        ) : null}
        {task.lifecycle !== 'ready' ? (
          <span style={{ marginLeft: 6, color: color.muted, fontSize: fontSize.sm }}>
            ({task.lifecycle})
          </span>
        ) : null}
      </div>
    </li>
  )
}
