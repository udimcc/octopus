/**
 * Global keyboard shortcuts (DESIGN §5.4). Mounted once in `App`.
 *
 * SAFETY RULE (§5.4): we only intercept **Shift-modified** chords. A terminal must
 * receive `Ctrl+C`, `Ctrl+V`, `Ctrl+D`, etc. untouched — stealing them would break
 * the very thing the app hosts. Requiring Shift on every global chord guarantees we
 * never shadow a bare terminal control key.
 *
 * Bindings:
 *   Ctrl+Shift+]   next task            Ctrl+Shift+[   previous task
 *   Ctrl+Shift+Tab cycle sessions       Ctrl+Shift+T   new terminal (active task)
 *   Ctrl+Shift+N   new task             Ctrl+Shift+W   close active session
 *   Ctrl+Shift+F   terminal search      Esc            (handled by open modals)
 *
 * DELIBERATE OMISSIONS: `DESIGN §5.4` also lists `Ctrl+Tab` and `Ctrl+Shift+C/V`.
 * `Ctrl+Tab` violates the Shift-only-intercept safety rule (bare Ctrl chord), and
 * `Ctrl+Shift+C/V` are the terminal's own copy/paste (xterm/Chromium reserve them).
 * Both are intentionally NOT bound here; session cycling uses `Ctrl+Shift+Tab`.
 *
 * `Ctrl+Shift+N` (new task) and `Ctrl+Shift+F` (search) are surfaced via callbacks
 * because they drive React-local UI (the modal / the terminal search box) that the
 * store doesn't own; everything else dispatches straight to the backend.
 */

import { useEffect } from 'react'
import { useStore } from '../store/store'

export interface KeyboardShortcutHandlers {
  /** Open the New-Task modal (owned by `ProgressPanel`). */
  readonly onNewTask: () => void
  /** Open terminal search in the active pane (owned by `TerminalPane`). */
  readonly onSearch?: () => void
}

export function useKeyboardShortcuts({ onNewTask, onSearch }: KeyboardShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Only ever act on Ctrl+Shift chords (never bare Ctrl — see the safety rule).
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return

      const store = useStore.getState()
      const { taskOrder, activeTaskId } = store

      // Cycle the active task by `delta`, wrapping, then switch to it.
      const cycleTask = (delta: number): void => {
        if (taskOrder.length === 0) return
        const cur = activeTaskId ? taskOrder.indexOf(activeTaskId) : -1
        const next = taskOrder[(cur + delta + taskOrder.length) % taskOrder.length]
        if (!next) return
        store.setActiveTask(next)
        void window.octopusAPI.tasks.switch({ taskId: next })
      }

      // Cycle the active session within the active task by `delta`, wrapping.
      const cycleSession = (delta: number): void => {
        if (!activeTaskId) return
        const task = store.tasks[activeTaskId]
        if (!task || task.sessionIds.length === 0) return
        const curId = store.activeSessionByTask[activeTaskId]
        const cur = curId ? task.sessionIds.indexOf(curId) : -1
        const next =
          task.sessionIds[(cur + delta + task.sessionIds.length) % task.sessionIds.length]
        if (next) store.setActiveSession(activeTaskId, next)
      }

      // `e.code` is layout-independent for the bracket/letter keys; `Tab` uses `key`.
      switch (e.code) {
        case 'BracketRight':
          e.preventDefault()
          cycleTask(1)
          return
        case 'BracketLeft':
          e.preventDefault()
          cycleTask(-1)
          return
        case 'Tab':
          e.preventDefault()
          cycleSession(1)
          return
        case 'KeyT':
          e.preventDefault()
          if (activeTaskId && store.tasks[activeTaskId]?.lifecycle === 'ready') {
            void window.octopusAPI.sessions.create({ taskId: activeTaskId })
          }
          return
        case 'KeyN':
          e.preventDefault()
          onNewTask()
          return
        case 'KeyW':
          e.preventDefault()
          if (activeTaskId) {
            const sid = store.activeSessionByTask[activeTaskId]
            if (sid) void window.octopusAPI.sessions.close({ sessionId: sid })
          }
          return
        case 'KeyF':
          e.preventDefault()
          onSearch?.()
          return
        default:
          return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onNewTask, onSearch])
}
