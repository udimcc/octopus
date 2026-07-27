/**
 * The workspace for a SECONDARY window (DESIGN §5.6, §6.7). A secondary window has
 * no progress panel: it renders only the sessions of the shared `activeTaskId` that
 * belong to THIS window (`session.windowId === thisWindowId`).
 *
 * It reuses `TaskView` exactly as the main `TaskWorkspace` does — `TaskView` already
 * filters its panes/tabs to `thisWindowId`, so a session moved in mounts here and one
 * moved out unmounts. The same keep-alive rule applies (§5.3): every task is mounted;
 * only the active one is laid out, the rest stay alive but hidden so their terminals
 * keep running.
 *
 * All windows sync on the single `activeTaskId` (switch a task → sessions switch in
 * every window). A secondary window may host ZERO of the active task's sessions — it
 * then shows an empty prompt inviting the user to drag a tab over.
 */

import { TaskView } from './TaskView'
import { useStore } from '../store/store'
import { color, fontSize } from '../style/tokens'

export function SecondaryWorkspace(): React.JSX.Element {
  const taskOrder = useStore((s) => s.taskOrder)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const windowId = useStore((s) => s.windowId)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)

  // Does this window host any session of the active task? Drives the empty state.
  const activeTask = activeTaskId ? tasks[activeTaskId] : undefined
  const hostsActiveSessions = activeTask
    ? activeTask.sessionIds.some((id) => sessions[id]?.windowId === windowId)
    : false

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
      {/* Non-interactive overlay when this window hosts none of the active task's
          sessions — the active `TaskView` still renders an (empty) pane beneath, so
          this must not steal its clicks (`pointerEvents: none`). */}
      {!hostsActiveSessions ? (
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
          <p style={{ margin: 0, fontSize: fontSize.lg }}>
            No sessions here — drag a tab onto this window.
          </p>
        </div>
      ) : null}
    </section>
  )
}
