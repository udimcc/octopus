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
 * COPY/PASTE (`Ctrl+Shift+C/V`, §5.4) are NOT handled here: they act on a specific
 * terminal's selection/buffer, so they're bound in `TerminalPane` (which holds the
 * live `Terminal`) via the configurable `copyKey`/`pasteKey` chords. xterm renders
 * its selection on a canvas/rows layer, not as a DOM selection, so the browser's
 * native `Ctrl+C` copies nothing — the pane copies `term.getSelection()` to the OS
 * clipboard (through `octopusAPI.clipboard`) and pastes via `term.paste()` instead.
 *
 * New task and search are surfaced via callbacks because they drive React-local UI
 * (the modal / the terminal search box) that the store doesn't own; everything else
 * dispatches straight to the backend.
 */

import { useEffect } from 'react'
import { useStore } from '../store/store'
import { groupTasksByRepo } from '../store/group-tasks'
import { matchesChord } from '../keybindings/chords'

/**
 * The FIXED chord that toggles the state-detection debug overlay (§11). Not a
 * user-configurable binding (it's a diagnostic, not a workflow action), so it lives
 * here as a constant rather than in `settings`. Guaranteed ≥1 modifier, so it never
 * shadows a bare terminal keystroke (§5.4).
 */
export const DEBUG_OVERLAY_CHORD = 'Ctrl+Shift+KeyD'

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

      // Cycle the active task by `delta`, wrapping, then switch to it. The walk order
      // follows the VISUAL order of the Progress panel, not `taskOrder` (creation/append
      // order): in the Flat view those coincide, but the Grouped view (§5.1) buckets
      // tasks by repo, so a newly-opened task slots next to its repo-mates rather than at
      // the end. We rebuild the panel's exact order with the same pure `groupTasksByRepo`
      // helper it renders from, keyed on the `groupTasksByRepo` setting, so keyboard
      // cycling matches what the user sees.
      const cycleTask = (delta: number): void => {
        const order = store.settings.groupTasksByRepo
          ? groupTasksByRepo(taskOrder, store.tasks).flatMap((g) => g.taskIds)
          : taskOrder
        if (order.length === 0) return
        const cur = activeTaskId ? order.indexOf(activeTaskId) : -1
        const next = order[(cur + delta + order.length) % order.length]
        if (!next) return
        store.setActiveTask(next)
        void window.octopusAPI.tasks.switch({ taskId: next })
      }

      // Cycle the active session of the active task by `delta`, wrapping. Cycling spans
      // ALL windows (§5.4) but is GROUPED by window: we take the task's global tab order
      // (`task.sessionIds`, already ordered by each session's `order`) and STABLE-sort it
      // by the hosting window's rank — its index in `store.windows`, which is creation
      // order (hydrated ORDER BY created_at, then append-on-`windowCreated`). A stable sort
      // keeps each window's tabs in their tab order, so the cycle walks window 1's tabs,
      // then window 2's, etc., and wraps across the whole set. We anchor "current" on the
      // GLOBAL `activeSessionByTask` pointer (switching crosses windows and updates it
      // everywhere) and dispatch `sessions.switch`, which round-trips, moves the persisted
      // pointer, raises the hosting window, and broadcasts `activeSessionChanged`.
      const cycleSession = (delta: number): void => {
        if (!activeTaskId) return
        const task = store.tasks[activeTaskId]
        if (!task) return
        // Window rank = index in `store.windows` (creation order). Orphans (window not
        // tracked) sort to the end deterministically rather than jumping to the front.
        const windowRank = (id: string): number => {
          const w = store.sessions[id]?.windowId
          const idx = w === undefined ? -1 : store.windows.findIndex((win) => win.id === w)
          return idx === -1 ? store.windows.length : idx
        }
        const ids = [...task.sessionIds].sort((a, b) => windowRank(a) - windowRank(b))
        if (ids.length === 0) return
        const curId = store.activeSessionByTask[activeTaskId]
        const cur = curId ? ids.indexOf(curId) : -1
        const next = ids[(cur + delta + ids.length) % ids.length]
        if (next) void window.octopusAPI.sessions.switch({ sessionId: next })
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
      // Fixed diagnostic chord (§11): toggle the state-detection debug overlay.
      if (matchesChord(e, DEBUG_OVERLAY_CHORD)) {
        e.preventDefault()
        store.toggleDebugOverlay()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onNewTask, onSearch])
}
