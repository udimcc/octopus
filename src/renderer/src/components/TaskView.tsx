/**
 * The workspace for one task: its `SessionTabBar` + the keep-alive pane stack
 * (DESIGN §5.1/§5.3). Extracted from the M5 inline `TaskView`; the tab strip is
 * now `SessionTabBar` and each pane is `SessionPane`.
 *
 * KEEP-ALIVE IS LOAD-BEARING (§5.3): a hidden task is NOT unmounted — it stays in
 * the DOM at `position:absolute; width/height:0; visibility:hidden` so its
 * terminals keep running, their scrollback survives, and their WebGL contexts are
 * not dropped (which `display:none` would do). Preserve these exact rules.
 */

import { SessionPane } from './SessionPane'
import { SessionTabBar } from './SessionTabBar'
import { useStore, activeSessionInWindow } from '../store/store'

export interface TaskViewProps {
  readonly taskId: string
  readonly active: boolean
}

export function TaskView({ taskId, active }: TaskViewProps): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const sessions = useStore((s) => s.sessions)
  const windowId = useStore((s) => s.windowId)
  // THIS window's marked session (§3.7) — not shared with other windows, so a switch to
  // a session hosted elsewhere leaves this window showing what it had.
  const activeSessionId = useStore((s) => activeSessionInWindow(s, taskId, s.windowId))

  // Only this window's sessions render here (V1.5, §5.6): a session moved to another
  // window unmounts its pane so its terminal stops rendering in this one. Derived in
  // the render body from stable slices (not a selector) so the fresh array doesn't
  // defeat zustand's Object.is bail-out.
  const windowSessionIds = task
    ? task.sessionIds.filter((id) => sessions[id]?.windowId === windowId)
    : []

  // Hidden tasks stay mounted but out of layout so their terminals keep running.
  const style: React.CSSProperties = active
    ? {
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-app)'
      }
    : { position: 'absolute', width: 0, height: 0, overflow: 'hidden', visibility: 'hidden' }

  if (!task) return <div style={style} />

  return (
    <div style={style}>
      <SessionTabBar taskId={taskId} />
      <div
        className="pane-area"
        style={{ position: 'relative', flex: 1, minHeight: 0, height: '100%' }}
      >
        {windowSessionIds.map((sid) => {
          const s = sessions[sid]
          if (!s) return null
          return <SessionPane key={sid} session={s} active={active && sid === activeSessionId} />
        })}
      </div>
    </div>
  )
}
