/**
 * Global keyboard shortcuts (DESIGN §5.4). Mounted once in `App`.
 *
 * SAFETY RULE (§5.4): a terminal must receive `Ctrl+C`, `Ctrl+V`, `Ctrl+D`, etc.
 * untouched — stealing them would break the very thing the app hosts. Every global
 * chord is user-configurable and the settings dialog enforces ≥1 modifier, so a
 * binding can never shadow a bare terminal keystroke.
 *
 * CONFIGURABLE KEYS: all eight actions are FREE-FORM chords read from `settings` —
 * `sessionNextKey` / `sessionPrevKey` (cycle sessions), `taskNextKey` / `taskPrevKey`
 * (move between tasks), `newSessionKey` (new terminal in the active task), `newTaskKey`
 * (open the New-Task modal), `closeSessionKey` (close the active session), and
 * `searchKey` (terminal search). Each is a canonical chord string (see
 * `keybindings/chords.ts`). Defaults: session next/prev `Ctrl+Shift+ArrowRight` /
 * `Ctrl+Shift+ArrowLeft`; task next/prev `Ctrl+Shift+ArrowDown` / `Ctrl+Shift+ArrowUp`;
 * new session `Ctrl+Shift+N`; new task `Ctrl+Shift+T`; close session `Ctrl+Shift+W`;
 * search `Ctrl+Shift+F`. Each is bound independently (no "opposite" inference) and
 * matched with `matchesChord`. The settings dialog blocks a collision between them
 * (and against `RESERVED_CHORDS` in `chords.ts`, currently empty).
 *
 * DELIBERATE OMISSIONS: `DESIGN §5.4` also lists `Ctrl+Shift+C/V` (the terminal's own
 * copy/paste — xterm/Chromium reserve them); they are intentionally NOT bound here.
 *
 * New task and search are surfaced via callbacks because they drive React-local UI
 * (the modal / the terminal search box) that the store doesn't own; everything else
 * dispatches straight to the backend.
 */

import { useEffect } from 'react'
import { useStore } from '../store/store'
import { matchesChord } from '../keybindings/chords'

export interface KeyboardShortcutHandlers {
  /** Open the New-Task modal (owned by `ProgressPanel`). */
  readonly onNewTask: () => void
  /** Open terminal search in the active pane (owned by `TerminalPane`). */
  readonly onSearch?: () => void
}

export function useKeyboardShortcuts({ onNewTask, onSearch }: KeyboardShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
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

      // Create a new session (terminal) in the active task, if it is `ready`.
      const newSession = (): void => {
        if (activeTaskId && store.tasks[activeTaskId]?.lifecycle === 'ready') {
          void window.octopusAPI.sessions.create({ taskId: activeTaskId })
        }
      }

      // Close the active session of the active task, if there is one.
      const closeSession = (): void => {
        if (!activeTaskId) return
        const sid = store.activeSessionByTask[activeTaskId]
        if (sid) void window.octopusAPI.sessions.close({ sessionId: sid })
      }

      // Every configurable chord comes from settings and is bound independently. A
      // custom chord (e.g. `Alt+K`) may not be Ctrl+Shift, so we match on the chord
      // itself; settings guarantees ≥1 modifier so a binding never shadows a bare key.
      const {
        sessionNextKey,
        sessionPrevKey,
        taskNextKey,
        taskPrevKey,
        newSessionKey,
        newTaskKey,
        closeSessionKey,
        searchKey
      } = store.settings
      if (matchesChord(e, sessionNextKey)) {
        e.preventDefault()
        cycleSession(1)
        return
      }
      if (matchesChord(e, sessionPrevKey)) {
        e.preventDefault()
        cycleSession(-1)
        return
      }
      if (matchesChord(e, taskNextKey)) {
        e.preventDefault()
        cycleTask(1)
        return
      }
      if (matchesChord(e, taskPrevKey)) {
        e.preventDefault()
        cycleTask(-1)
        return
      }
      if (matchesChord(e, newSessionKey)) {
        e.preventDefault()
        newSession()
        return
      }
      if (matchesChord(e, newTaskKey)) {
        e.preventDefault()
        onNewTask()
        return
      }
      if (matchesChord(e, closeSessionKey)) {
        e.preventDefault()
        closeSession()
        return
      }
      if (matchesChord(e, searchKey)) {
        e.preventDefault()
        onSearch?.()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onNewTask, onSearch])
}
