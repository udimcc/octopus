/**
 * The renderer composition root (DESIGN §5.1, §5.6). It wires the one event
 * subscription and hydrates the store on mount, then lays out this window by ROLE:
 *   - **main** → the left `ProgressPanel` (task list + controls) and the right
 *     `TaskWorkspace` (keep-alive session panes) — the full IDE.
 *   - **secondary** (V1.5) → session-only: no progress panel, just the active
 *     task's sessions that belong to THIS window (`SecondaryWorkspace`).
 * Both share the `Toaster` and the boot sequence; only the main window mounts the
 * New-Task modal + task-creation shortcut. All real UI lives in `components/`.
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
import { SecondaryWorkspace } from './components/SecondaryWorkspace'
import { Toaster } from './components/Toaster'
import { NewTaskModal } from './components/NewTaskModal'
import { DebugOverlay } from './components/DebugOverlay'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'

const shellStyle: React.CSSProperties = {
  display: 'flex',
  height: '100vh',
  margin: 0,
  background: 'var(--bg-app)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-sans)'
}

/**
 * Track this window's OS focus (§9.5) so ready-for-review raises only for sessions
 * the user isn't looking at, and regaining focus clears the visible one. Seeded from
 * `document.hasFocus()` for a window that opens already-focused.
 */
function useWindowFocus(): void {
  const setWindowFocused = useStore((s) => s.setWindowFocused)
  useEffect(() => {
    setWindowFocused(document.hasFocus())
    const onFocus = (): void => setWindowFocused(true)
    const onBlur = (): void => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [setWindowFocused])
}

/**
 * Record "I watched it finish in place" (§9.5). A session that finishes (Working →
 * Idle) while it is ALREADY the on-screen tab fires no focus *transition*, so the
 * transition-based clears never mark it seen — and the review dot would then surface
 * the moment the user switches away from a session they watched finish. This effect
 * closes that gap: on every settled render it clears the finished-unseen flag for the
 * currently on-screen session. It reads the reliable present-time focus (never the flaky
 * Working→Idle instant, §9.7), the same robustness the display-time suppression relies
 * on. The action is idempotent (a no-op unless the visible session is flagged), so
 * re-running it on unrelated store changes is harmless.
 */
function useMarkVisibleSessionSeen(): void {
  const markVisibleSessionSeen = useStore((s) => s.markVisibleSessionSeen)
  const windowFocused = useStore((s) => s.windowFocused)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const activeSessionByTask = useStore((s) => s.activeSessionByTask)
  const sessions = useStore((s) => s.sessions)
  const hasUnseenFinishedTurn = useStore((s) => s.hasUnseenFinishedTurn)
  useEffect(() => {
    markVisibleSessionSeen()
  }, [
    markVisibleSessionSeen,
    windowFocused,
    activeTaskId,
    activeSessionByTask,
    sessions,
    hasUnseenFinishedTurn
  ])
}

/** Subscribe to events + hydrate the store once on mount (shared by both roles). */
function useBoot(): void {
  const hydrate = useStore((s) => s.hydrate)
  const applyEvent = useStore((s) => s.applyEvent)

  useEffect(() => {
    const unsubscribe = initEventRouting(applyEvent)
    void window.octopusAPI.app.getState().then((state) => {
      hydrate(state)
      // Kick off restore of the initially-active task's sessions NOW (§6.3): the
      // backend only spawns a restored task's PTYs (and replays their scrollback)
      // inside `switchTask → startTaskSessions`, and nothing else fires a switch at
      // launch. Without this, history for the active task wouldn't appear until the
      // user clicked around. The backend pointer is already this id (set by
      // `Workspace.hydrate`), so this switch skips the pointer move + event and only
      // runs the idempotent session start. Every window issues it (idempotent), so a
      // window opened later still gets its sessions started.
      if (state.activeTaskId) void window.octopusAPI.tasks.switch({ taskId: state.activeTaskId })
    })
    return unsubscribe
  }, [hydrate, applyEvent])
}

/** Search the active task's currently-visible session (shared shortcut handler). */
function openSearchForActive(): void {
  const { activeTaskId, activeSessionByTask } = useStore.getState()
  if (!activeTaskId) return
  const sessionId = activeSessionByTask[activeTaskId]
  if (sessionId) openSearch(sessionId)
}

/** The main window: progress panel + full workspace + task creation (§5.1). */
function MainWindowApp(): React.JSX.Element {
  const [showNewTask, setShowNewTask] = useState(false)
  const openNewTask = useCallback(() => setShowNewTask(true), [])
  useKeyboardShortcuts({ onNewTask: openNewTask, onSearch: openSearchForActive })

  return (
    <main style={shellStyle}>
      <ProgressPanel onNewTask={openNewTask} />
      <TaskWorkspace />
      <Toaster />
      <DebugOverlay />
      {showNewTask ? <NewTaskModal onClose={() => setShowNewTask(false)} /> : null}
    </main>
  )
}

/** A secondary window (V1.5, §5.6): session-only, no progress panel or New Task. */
function SecondaryWindowApp(): React.JSX.Element {
  // Only the search shortcut is meaningful here; task creation lives in main.
  useKeyboardShortcuts({ onNewTask: () => {}, onSearch: openSearchForActive })

  return (
    <main style={shellStyle}>
      <SecondaryWorkspace />
      <Toaster />
      <DebugOverlay />
    </main>
  )
}

export function App(): React.JSX.Element {
  useBoot()
  useWindowFocus()
  useMarkVisibleSessionSeen()
  const windowRole = useStore((s) => s.windowRole)
  return windowRole === 'secondary' ? <SecondaryWindowApp /> : <MainWindowApp />
}
