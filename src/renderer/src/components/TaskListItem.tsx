/**
 * One task row in the `ProgressPanel` list (DESIGN §5.1/§5.4). Clicking activates
 * the task (`setActiveTask` locally + `tasks.switch` to the backend), double-click
 * renames it in place (`tasks.rename`), and the row is a dnd-kit sortable handle so
 * tasks reorder by dragging (`tasks.reorder`, reconciled by `taskReordered`).
 *
 * The row leads with the task's aggregate status icon (§5.4, §9) — the worst-wins
 * roll-up of its sessions, derived backend-side and carried on `task.state`. When
 * not `ready` it also shows a "(lifecycle)" suffix so provisioning/stale/failed
 * states stay legible.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EditableLabel } from './EditableLabel'
import { StatusIcon } from './StatusIcon'
import { color, fontSize } from '../style/tokens'
import type { TaskEntry } from '../store/store'

export interface TaskListItemProps {
  readonly task: TaskEntry
  readonly active: boolean
  readonly onActivate: () => void
  readonly onRename: (name: string) => void
  /** Any session in this task ready-for-review (§9.5); decorates the status icon. */
  readonly readyForReview: boolean
  /** Indent the row under a repo header in the grouped view (§5.1). */
  readonly indent?: boolean
}

export function TaskListItem({
  task,
  active,
  onActivate,
  onRename,
  readyForReview,
  indent = false
}: TaskListItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id
  })

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
        <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center', marginRight: 6 }}>
          <StatusIcon state={task.state} readyForReview={readyForReview} />
        </span>
        <EditableLabel
          value={task.name}
          onCommit={onRename}
          editAriaLabel="rename task"
          style={{ flex: 1, minWidth: 0 }}
        />
        {task.lifecycle !== 'ready' ? (
          <span style={{ marginLeft: 6, color: color.muted, fontSize: fontSize.sm }}>
            ({task.lifecycle})
          </span>
        ) : null}
      </div>
    </li>
  )
}
