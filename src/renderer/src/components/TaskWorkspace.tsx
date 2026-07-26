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
import { color, fontSize } from '../style/tokens'

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
        minWidth: 0,
        background: color.bgApp
      }}
    >
      {taskOrder.map((id) => (
        <TaskView key={id} taskId={id} active={id === activeTaskId} />
      ))}
      {taskOrder.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: color.muted
          }}
        >
          <span style={{ fontSize: 40, opacity: 0.5 }}>🐙</span>
          <p style={{ margin: 0, fontSize: fontSize.lg }}>No tasks yet — create one to begin.</p>
        </div>
      ) : null}
    </section>
  )
}
