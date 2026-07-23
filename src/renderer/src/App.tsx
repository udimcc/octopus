/**
 * M5 vertical slice (DESIGN §5.1/§5.3). The minimal-but-real shell: hydrate the
 * store from the backend on mount, wire the single event subscription, and render
 * a left task list + a right workspace of keep-alive terminal panes. The full
 * ProgressPanel / NewTaskModal / SessionTabBar UX lands in M6; this proves the
 * end-to-end path (create task → open terminal → type → see output → switch).
 *
 * Keep-alive is load-bearing (§5.3): EVERY session pane of EVERY task is mounted
 * at once and merely hidden with `visibility:hidden; position:absolute` (never
 * `display:none`, which would zero the container and force xterm to reflow on
 * show). That's why switching tasks preserves scrollback with no reflow pop.
 */

import { useEffect, useState } from 'react'
import { useStore } from './store/store'
import { initEventRouting } from './pty/pty-router'
import { resolveSessionView } from './session-views/session-view-factory'
import { NewTaskModal } from './components/NewTaskModal'
import type { SessionDTO } from '../../shared/dto'

/** One session pane, kept mounted and toggled visible/hidden (§5.3). */
function SessionPane({
  session,
  active
}: {
  session: SessionDTO
  active: boolean
}): React.JSX.Element {
  const View = resolveSessionView(session.typeId)
  const style: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    visibility: active ? 'visible' : 'hidden'
  }
  return (
    <div style={style}>
      {View ? (
        <View sessionId={session.id} active={active} />
      ) : (
        <p>Unsupported: {session.typeId}</p>
      )}
    </div>
  )
}

/** The workspace for one task: its session tabs + the keep-alive pane stack. */
function TaskView({ taskId, active }: { taskId: string; active: boolean }): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionByTask[taskId])
  const setActiveSession = useStore((s) => s.setActiveSession)

  // Hidden tasks stay mounted but out of layout so their terminals keep running.
  const style: React.CSSProperties = active
    ? { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
    : { position: 'absolute', width: 0, height: 0, overflow: 'hidden', visibility: 'hidden' }

  if (!task) return <div style={style} />

  const openTerminal = (): void => {
    void window.octopusAPI.sessions.create({ taskId })
  }

  return (
    <div style={style}>
      <div className="session-tabs" style={{ display: 'flex', gap: 4, padding: 4 }}>
        {task.sessionIds.map((sid) => {
          const s = sessions[sid]
          if (!s) return null
          const isActive = sid === activeSessionId
          return (
            <button
              key={sid}
              onClick={() => setActiveSession(taskId, sid)}
              aria-pressed={isActive}
              style={{ fontWeight: isActive ? 'bold' : 'normal' }}
            >
              {s.title}
              {s.lifecycle === 'exited' ? ' (exited)' : ''}
              <span
                aria-label="close session"
                onClick={(e) => {
                  e.stopPropagation()
                  void window.octopusAPI.sessions.close({ sessionId: sid })
                }}
                style={{ marginLeft: 6, cursor: 'pointer' }}
              >
                ×
              </span>
            </button>
          )
        })}
        <button onClick={openTerminal} disabled={task.lifecycle !== 'ready'}>
          + Terminal
        </button>
      </div>
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

export function App(): React.JSX.Element {
  const hydrate = useStore((s) => s.hydrate)
  const applyEvent = useStore((s) => s.applyEvent)
  const taskOrder = useStore((s) => s.taskOrder)
  const tasks = useStore((s) => s.tasks)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const setActiveTask = useStore((s) => s.setActiveTask)
  const [showNewTask, setShowNewTask] = useState(false)

  useEffect(() => {
    const unsubscribe = initEventRouting(applyEvent)
    void window.octopusAPI.app.getState().then(hydrate)
    return unsubscribe
  }, [hydrate, applyEvent])

  const switchTask = (taskId: string): void => {
    setActiveTask(taskId)
    void window.octopusAPI.tasks.switch({ taskId })
  }

  return (
    <main style={{ display: 'flex', height: '100vh', margin: 0 }}>
      <aside
        style={{
          width: 240,
          borderRight: '1px solid #ccc',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <h1 style={{ fontSize: 18, padding: 8, margin: 0 }}>Octopus</h1>
        <div style={{ padding: 8 }}>
          <button onClick={() => setShowNewTask(true)} style={{ width: '100%' }}>
            + New Task
          </button>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1 }}>
          {taskOrder.map((id) => {
            const t = tasks[id]
            if (!t) return null
            const isActive = id === activeTaskId
            return (
              <li key={id}>
                <button
                  onClick={() => switchTask(id)}
                  aria-pressed={isActive}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    background: isActive ? '#e0e0ff' : 'transparent',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                >
                  {t.name}
                  {t.lifecycle !== 'ready' ? ` (${t.lifecycle})` : ''}
                </button>
              </li>
            )
          })}
        </ul>
      </aside>
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
          <p style={{ padding: 16, color: '#888' }}>No tasks yet — create one to begin.</p>
        ) : null}
      </section>
      {showNewTask ? <NewTaskModal onClose={() => setShowNewTask(false)} /> : null}
    </main>
  )
}
