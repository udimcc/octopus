/**
 * One task row in the `ProgressPanel` list (DESIGN §5.1/§5.4). Clicking activates
 * the task (`setActiveTask` locally + `tasks.switch` to the backend), double-click
 * renames it in place (`tasks.rename`), and the row is a dnd-kit sortable handle so
 * tasks reorder by dragging (`tasks.reorder`, reconciled by `taskReordered`).
 *
 * V1 shows NO status icon (that's a V2 seam, §10) — just the name and, when the
 * task is not `ready`, a "(lifecycle)" suffix so provisioning/stale/failed states
 * are legible.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EditableLabel } from './EditableLabel'
import { color } from '../style/tokens'
import type { TaskEntry } from '../store/store'

export interface TaskListItemProps {
  readonly task: TaskEntry
  readonly active: boolean
  readonly onActivate: () => void
  readonly onRename: (name: string) => void
}

export function TaskListItem({
  task,
  active,
  onActivate,
  onRename
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
    padding: '6px 8px',
    background: active ? color.activeRow : 'transparent',
    cursor: 'pointer',
    boxSizing: 'border-box'
  }

  return (
    <li ref={setNodeRef} style={{ listStyle: 'none' }}>
      <div
        {...attributes}
        {...listeners}
        role="button"
        aria-pressed={active}
        aria-label={task.name}
        onClick={onActivate}
        style={rowStyle}
      >
        <EditableLabel
          value={task.name}
          onCommit={onRename}
          editAriaLabel="rename task"
          style={{ flex: 1, minWidth: 0 }}
        />
        {task.lifecycle !== 'ready' ? (
          <span style={{ marginLeft: 6, color: color.muted, fontSize: 12 }}>
            ({task.lifecycle})
          </span>
        ) : null}
      </div>
    </li>
  )
}
