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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, activeSessionInWindow, FOCUS_FLASH_MS } from './store/store'
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
 * Track this window's OS focus (§9.5) so ready-for-review shows only for sessions the
 * user isn't looking at, and gaining focus flashes the marked tab (§5.4). Seeded from
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
 *
 * When it DOES clear a flag, relay the "seen" to main (`sessions.markSeen`) so every
 * OTHER window folds it into its ready-for-review too (§9.5). A turn finished in place
 * fires no focus *transition* to broadcast, so the main window's task rollup — which
 * spans sessions in any window but knows only its own focus — can't otherwise learn the
 * session was seen. Only the hosting (focused) window clears here, so only it relays.
 *
 * It is also the ONLY "looked at" clear for a task switch and a window focus gain: each
 * window marks its own session (§3.7), so only the focused window knows which one is on
 * screen — the store's task-switch / focus paths deliberately leave the flag to this.
 */
function useMarkVisibleSessionSeen(): void {
  const markVisibleSessionSeen = useStore((s) => s.markVisibleSessionSeen)
  const windowFocused = useStore((s) => s.windowFocused)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const activeSessionByTask = useStore((s) => s.activeSessionByTask)
  const sessions = useStore((s) => s.sessions)
  const hasUnseenFinishedTurn = useStore((s) => s.hasUnseenFinishedTurn)
  useEffect(() => {
    const seen = markVisibleSessionSeen()
    if (seen) window.octopusAPI.sessions.markSeen({ sessionId: seen })
  }, [
    markVisibleSessionSeen,
    windowFocused,
    activeTaskId,
    activeSessionByTask,
    sessions,
    hasUnseenFinishedTurn
  ])
}

/**
 * Persist the focused session (§5.4, I10). The focused session is THIS window's mark for
 * the active task while this window has OS focus, so whenever that pair changes — focus
 * gained (incl. a click into the terminal body), or the mark moved while focused — tell
 * main via the persist-only `sessions.focus` (no event, no raise). Not `sessions.switch`:
 * on a cross-window keyboard switch the raise's focus event can land BEFORE the
 * `activeSessionChanged` that moves this window's mark, and a switch to the stale mark
 * would broadcast and flip the host back. Persist-only writes are just eventually
 * consistent (old mark, then new mark — FIFO through the single writer).
 */
function usePersistFocusedSession(): void {
  const windowFocused = useStore((s) => s.windowFocused)
  const focusedSid = useStore((s) =>
    s.activeTaskId ? activeSessionInWindow(s, s.activeTaskId, s.windowId) : undefined
  )
  const lastSent = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!windowFocused) {
      lastSent.current = undefined // re-focusing re-sends: another window may have moved it
      return
    }
    if (!focusedSid || lastSent.current === focusedSid) return
    lastSent.current = focusedSid
    window.octopusAPI.sessions.focus({ sessionId: focusedSid })
  }, [windowFocused, focusedSid])
}

/** End the focus flash (§5.4) after {@link FOCUS_FLASH_MS}; a newer flash restarts the timer. */
function useFocusFlashExpiry(): void {
  const on = useStore((s) => s.focusFlashOn)
  const seq = useStore((s) => s.focusFlashSeq)
  const endFocusFlash = useStore((s) => s.endFocusFlash)
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => endFocusFlash(seq), FOCUS_FLASH_MS)
    return () => clearTimeout(timer)
  }, [on, seq, endFocusFlash])
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

/** Search the active task's session visible in THIS window (shared shortcut handler). */
function openSearchForActive(): void {
  const state = useStore.getState()
  if (!state.activeTaskId) return
  const sessionId = activeSessionInWindow(state, state.activeTaskId, state.windowId)
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
  usePersistFocusedSession()
  useFocusFlashExpiry()
  const windowRole = useStore((s) => s.windowRole)
  return windowRole === 'secondary' ? <SecondaryWindowApp /> : <MainWindowApp />
}
