/**
 * The renderer composition root (DESIGN §5.1). It wires the one event subscription
 * and hydrates the store on mount, then lays out the two panes — the left
 * `ProgressPanel` (task list + controls) and the right `TaskWorkspace` (keep-alive
 * session panes) — plus the `Toaster`, the New-Task modal, and global keyboard
 * shortcuts. All real UI lives in the extracted components under `components/`;
 * `App` only composes them.
 *
 * MOUNT ORDER IS LOAD-BEARING (§5.2/§6.5): subscribe via `initEventRouting` BEFORE
 * `getState().then(hydrate)`, so startup events the backend emits while we hydrate
 * are routed (buffered by the backend until the first listener attaches) rather
 * than lost. Do not reorder these two lines.
 */

import { useCallback, useEffect, useState } from 'react'
import { useStore } from './store/store'
import { initEventRouting } from './pty/pty-router'
import { openSearch } from './terminal/terminal-search'
import { ProgressPanel } from './components/ProgressPanel'
import { TaskWorkspace } from './components/TaskWorkspace'
import { Toaster } from './components/Toaster'
import { NewTaskModal } from './components/NewTaskModal'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'

export function App(): React.JSX.Element {
  const hydrate = useStore((s) => s.hydrate)
  const applyEvent = useStore((s) => s.applyEvent)
  const [showNewTask, setShowNewTask] = useState(false)

  useEffect(() => {
    const unsubscribe = initEventRouting(applyEvent)
    void window.octopusAPI.app.getState().then(hydrate)
    return unsubscribe
  }, [hydrate, applyEvent])

  const openNewTask = useCallback(() => setShowNewTask(true), [])
  const openSearchForActive = useCallback(() => {
    const { activeTaskId, activeSessionByTask } = useStore.getState()
    if (!activeTaskId) return
    const sessionId = activeSessionByTask[activeTaskId]
    if (sessionId) openSearch(sessionId)
  }, [])
  useKeyboardShortcuts({ onNewTask: openNewTask, onSearch: openSearchForActive })

  return (
    <main style={{ display: 'flex', height: '100vh', margin: 0 }}>
      <ProgressPanel onNewTask={openNewTask} />
      <TaskWorkspace />
      <Toaster />
      {showNewTask ? <NewTaskModal onClose={() => setShowNewTask(false)} /> : null}
    </main>
  )
}
