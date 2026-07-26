/**
 * The right-hand workspace (DESIGN §5.1). It mounts a `TaskView` for EVERY task
 * at once — only the active one is laid out; the rest are kept alive but hidden
 * (§5.3, enforced inside `TaskView`). Mounting them all is what lets task switching
 * be instant with no terminal reflow.
 *
 * The empty state (no tasks) prompts the user to create one.
 */

import { TaskView } from './TaskView'
import { useStore } from '../store/store'
import { color } from '../style/tokens'

export function TaskWorkspace(): React.JSX.Element {
  const taskOrder = useStore((s) => s.taskOrder)
  const activeTaskId = useStore((s) => s.activeTaskId)

  return (
    <section
      style={{
        flex: 1,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0
      }}
    >
      {taskOrder.map((id) => (
        <TaskView key={id} taskId={id} active={id === activeTaskId} />
      ))}
      {taskOrder.length === 0 ? (
        <p style={{ padding: 16, color: color.muted }}>No tasks yet — create one to begin.</p>
      ) : null}
    </section>
  )
}
