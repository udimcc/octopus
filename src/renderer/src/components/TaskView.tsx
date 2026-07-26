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
import { useStore } from '../store/store'

export interface TaskViewProps {
  readonly taskId: string
  readonly active: boolean
}

export function TaskView({ taskId, active }: TaskViewProps): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionByTask[taskId])

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
        {task.sessionIds.map((sid) => {
          const s = sessions[sid]
          if (!s) return null
          return <SessionPane key={sid} session={s} active={active && sid === activeSessionId} />
        })}
      </div>
    </div>
  )
}
