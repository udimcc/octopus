/**
 * The right-hand workspace (DESIGN §5.1). It mounts a `TaskView` for EVERY task
 * at once — only the active one is laid out; the rest are kept alive but hidden
 * (§5.3, enforced inside `TaskView`). Mounting them all is what lets task switching
 * be instant with no terminal reflow.
 *
 * The empty state (no tasks) prompts the user to create one.
 *
 * Window-view feature: in MAIN, selecting a task that's being viewed in its own
 * window shows a second, non-interactive overlay — "This task is shown in its own
 * window" — instead of (or rather, drawn OVER) that task's `TaskView`. `TaskView`
 * still mounts and lays out normally underneath (keep-alive, §5.3; it just has no
 * sessions to show, since `createView` already moved them out), so the overlay is
 * `pointerEvents: 'none'`, same pattern as `SecondaryWorkspace`'s empty state — it
 * lets clicks reach the (disabled, see `SessionTabBar`'s `canAddSession`) "+ New
 * Session" control underneath rather than needing its own copy of that logic. This
 * component is reused UNMODIFIED for a view window's own session area (`ViewWindowApp`
 * in `App.tsx`) and for a view's secondary windows: both belong to the task's own
 * window group, so `isViewedElsewhere` (group-aware, unlike the plain "has a view"
 * check) is false there and this empty state never shows over the task's own,
 * very-much-present sessions.
 */

import { TaskView } from './TaskView'
import { useStore, isViewedElsewhere } from '../store/store'
import { color, fontSize } from '../style/tokens'

export function TaskWorkspace(): React.JSX.Element {
  const taskOrder = useStore((s) => s.taskOrder)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const activeTaskViewedElsewhere = useStore(
    (s) => !!activeTaskId && isViewedElsewhere(s, activeTaskId)
  )

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
      {activeTaskViewedElsewhere ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: color.muted,
            pointerEvents: 'none'
          }}
        >
          <span style={{ fontSize: 40, opacity: 0.5 }}>🪟</span>
          <p style={{ margin: 0, fontSize: fontSize.lg }}>This task is shown in its own window.</p>
        </div>
      ) : null}
    </section>
  )
}
