/**
 * Global keyboard shortcuts (DESIGN §5.4). Mounted once in `App`.
 *
 * SAFETY RULE (§5.4): a terminal must receive `Ctrl+C`, `Ctrl+V`, `Ctrl+D`, etc.
 * untouched — stealing them would break the very thing the app hosts. Every global
 * chord is user-configurable and the settings dialog enforces ≥1 modifier, so a
 * binding can never shadow a bare terminal keystroke.
 *
 * CONFIGURABLE KEYS: all fifteen actions are FREE-FORM chords read from `settings` —
 * `sessionNextKey` / `sessionPrevKey` (cycle sessions), `taskNextKey` / `taskPrevKey`
 * (move between tasks), `newSessionKey` (new terminal in the active task), `newTaskKey`
 * (open the New-Task modal), `closeSessionKey` (close the active session), `searchKey`
 * (terminal search), `issuesKey` (toggle the Issues drawer), `splitRightKey` /
 * `splitDownKey` (split the focused pane with a new terminal, §5.7), and
 * `focusPaneLeftKey` / `focusPaneRightKey` / `focusPaneUpKey` / `focusPaneDownKey` (move
 * focus to the adjacent pane, §5.7). Each is a canonical chord string (see
 * `keybindings/chords.ts`). Defaults: session next/prev `Ctrl+Shift+ArrowRight` /
 * `Ctrl+Shift+ArrowLeft`; task next/prev `Ctrl+Shift+ArrowDown` / `Ctrl+Shift+ArrowUp`;
 * new session `Ctrl+Shift+N`; new task `Ctrl+Shift+T`; close session `Ctrl+Shift+W`;
 * search `Ctrl+Shift+F`; toggle issues `Alt+Shift+I`; split right/down `Ctrl+Shift+E` /
 * `Ctrl+Shift+O`; focus pane left/down/up/right `Ctrl+Shift+H/J/K/L` (vim-style; NOT
 * `Ctrl+Alt+Shift+Arrow`, which GNOME grabs for move-to-workspace before the keydown ever
 * reaches us). Each is bound independently (no "opposite" inference) and matched with
 * `matchesChord`, which compares the FULL modifier set, not a subset — so e.g. a custom
 * `Ctrl+Alt+Shift+ArrowRight` never also matches a `Ctrl+Shift+ArrowRight` binding
 * (session next). The settings dialog blocks a collision between them (and against
 * `RESERVED_CHORDS` in `chords.ts`, currently empty).
 *
 * ISSUES DRAWER (`issuesKey`, PRD "Issues window"): the drawer exists only in the main
 * window (§13.4/§13.5). In the main window the chord toggles the store's own guarded
 * `toggleIssuesDrawer()` action directly. In a secondary window (`store.windowRole ===
 * 'secondary'`) there is no drawer to toggle locally, so the chord fires
 * `window.octopusAPI.issues.toggleDrawer()` instead — a fire-and-forget IPC that asks
 * main to raise/focus the main window and relay `issuesDrawerToggle` to it.
 *
 * ESCAPE FALLBACK: the drawer's own `onKeyDown` handles Escape, but only when
 * the keydown's target is actually inside its DOM subtree — once focus has fallen
 * outside it entirely (e.g. a nested confirm dialog's autofocused button got disabled
 * or unmounted out from under the user), a `keydown` on `<body>` never reaches it.
 * This hook maps Escape to the same guarded close the drawer itself uses
 * (`toggleIssuesDrawer()`) whenever the main window has the drawer open and no other
 * `[aria-modal="true"]` dialog is currently showing (that dialog owns Escape itself
 * while it's up). Note `discardPrompt` can't be true here: it being true means
 * `DiscardChangesPrompt` (`aria-modal="true"`) is up, which is exactly the condition
 * that already made the clause above bail — so there is no `cancelDiscard()` branch
 * to parallel the drawer's own handler. The drawer's own handler calls
 * `e.stopPropagation()` on Escape, which also stops the underlying native event — so
 * whenever that handler actually sees the keypress, this fallback never does; the two
 * can't both fire for one keypress.
 *
 * DRAWER-OPEN CHORD SUPPRESSION: while the main window's Issues drawer covers
 * the workspace, only `issuesKey` itself and the task/session navigation chords
 * (`sessionNextKey`/`sessionPrevKey`/`taskNextKey`/`taskPrevKey`) still act — navigating
 * is harmless, since the drawer stays open and the workspace underneath just switches.
 * Everything else that acts on the now-hidden session (new/close session, search, split,
 * pane focus) is a no-op while the drawer is open, rather than operating invisibly behind it.
 *
 * COPY/PASTE (`Ctrl+Shift+C/V`, §5.4) are NOT handled here: they act on a specific
 * terminal's selection/buffer, so they're bound in `TerminalPane` (which holds the
 * live `Terminal`) via the configurable `copyKey`/`pasteKey` chords. xterm renders
 * its selection on a canvas/rows layer, not as a DOM selection, so the browser's
 * native `Ctrl+C` copies nothing — the pane copies `term.getSelection()` to the OS
 * clipboard (through `octopusAPI.clipboard`) and pastes via `term.paste()` instead.
 *
 * SPLIT PANES (§5.7, split-groups design): a split chord asks the backend to create a new
 * terminal already joined into the focused pane's group in ONE command (`sessions.create`'s
 * `split` intent) — forming a group if the focused pane is lone. There is no renderer-held
 * pending intent to track or cancel: the backend validates the anchor and joins atomically,
 * then publishes the usual `sessionCreated` (which marks the new session in its window) plus
 * `groupsChanged`/`sessionReordered`. The directional focus chords move the mark to the pane
 * adjacent to the focused one within the mark's OWN group's layout (`groupOfSession` +
 * `split-layout`'s `neighbor`) via the pure, local `focusPane` — a mark move never touches a
 * group. Next/prev session (`sessionNextKey`/`sessionPrevKey`) need no group-aware logic
 * here — they dispatch `sessions.switch`, which only moves the mark; `TaskView` derives
 * what's shown from the mark's group (`groupOfSession`, store.ts) at render time, so
 * cycling tabs never changes which group (if any) is shown.
 *
 * New task and search are surfaced via callbacks because they drive React-local UI
 * (the modal / the terminal search box) that the store doesn't own; everything else
 * dispatches straight to the backend.
 */

import { useEffect } from 'react'
import { useStore, activeSessionInWindow, groupOfSession } from '../store/store'
import { groupTasksByRepo } from '../store/group-tasks'
import { matchesChord } from '../keybindings/chords'
import { canSplit, neighbor, type PaneDirection } from '../store/split-layout'
import { measurePane } from '../terminal/terminal-metrics'
import type { SplitDirection } from '../../../shared/dto'

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

      // Escape fallback — see the header comment. Only engages when no
      // other modal dialog is up (it owns Escape itself while showing); checked
      // first since Escape never has a modifier and so can never also match one of
      // the configurable chords below.
      if (
        e.key === 'Escape' &&
        store.windowRole === 'main' &&
        store.issuesDrawerOpen &&
        !document.querySelector('[aria-modal="true"]')
      ) {
        e.preventDefault()
        // `store.discardPrompt` can't be true here — see the header comment — so
        // this is always the plain close, never `cancelDiscard()`.
        store.toggleIssuesDrawer()
        return
      }

      // Drawer-open chord suppression — see the header comment. Navigation
      // (session/task cycling) and `issuesKey` itself are exempt; checked once here
      // and consulted by the chord branches below rather than threaded through
      // every helper's own signature.
      const suppressedByDrawer = store.windowRole === 'main' && store.issuesDrawerOpen

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
      // then window 2's, etc., and wraps across the whole set. We anchor "current" on THIS
      // window's mark (§3.7): shortcuts are handled by the OS-focused window, whose mark IS
      // the focused session. We dispatch `sessions.switch`, which round-trips, moves the
      // persisted pointer, raises the hosting window, and broadcasts `activeSessionChanged`
      // (only the host moves its mark, so this window keeps showing what it had).
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
        const curId = activeSessionInWindow(store, activeTaskId, store.windowId)
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

      // Close the focused session — this window's mark for the active task — if any.
      const closeSession = (): void => {
        if (!activeTaskId) return
        const sid = activeSessionInWindow(store, activeTaskId, store.windowId)
        if (sid) void window.octopusAPI.sessions.close({ sessionId: sid })
      }

      // Split chord (§5.7, split-groups design): create a NEW terminal already joined into
      // the focused pane's group, next to its pane (forming a group if it's lone), in ONE
      // backend command. Refuses (with a toast, no split) when the focused pane is
      // measurable and halving it would leave either side under the minimum size
      // (`canSplit`); an unmeasurable pane (not yet mounted/registered) doesn't block the
      // split. No pending intent to record: the backend validates the anchor and joins
      // atomically, so there's nothing here to cancel on a failed ack.
      const trySplit = (dir: SplitDirection): void => {
        // A held chord auto-repeats: one split per press, not a burst of new sessions.
        if (e.repeat) return
        // Same gate as `newSession`: only a `ready` task can host a new session.
        if (!activeTaskId || store.tasks[activeTaskId]?.lifecycle !== 'ready') return
        const mark = activeSessionInWindow(store, activeTaskId, store.windowId)
        if (!mark) return
        const metrics = measurePane(mark)
        if (
          metrics &&
          !canSplit(
            metrics.widthPx,
            metrics.heightPx,
            metrics.cellWidthPx,
            metrics.cellHeightPx,
            dir
          )
        ) {
          store.pushToast('info', 'Pane too small to split')
          return
        }
        void window.octopusAPI.sessions
          .create({
            taskId: activeTaskId,
            split: { anchorSessionId: mark, dir }
          })
          .then((ack) => {
            if (!ack.ok) store.pushToast('error', ack.error ?? 'Failed to split')
          })
          .catch(() => store.pushToast('error', 'Failed to split'))
      }

      // Directional focus chord (§5.7, split-groups design): move the mark to the pane
      // adjacent to the focused one WITHIN THE MARK'S OWN GROUP's layout — groups enforce
      // same-window membership, so every neighbor found this way is already hosted here. A
      // no-op (the mark is lone here, or there's no neighbor that way) still consumes the
      // keydown — same as every other chord below when it has nothing to do.
      const focusDirection = (direction: PaneDirection): void => {
        if (!activeTaskId) return
        const mark = activeSessionInWindow(store, activeTaskId, store.windowId)
        if (!mark) return
        const group = groupOfSession(store, activeTaskId, mark)
        if (!group) return
        const target = neighbor(group.layout, mark, direction)
        if (target) store.focusPane(target)
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
        searchKey,
        issuesKey,
        splitRightKey,
        splitDownKey,
        focusPaneLeftKey,
        focusPaneRightKey,
        focusPaneUpKey,
        focusPaneDownKey
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
      // These four act on the (possibly now-hidden) workspace, so they're suppressed
      // while the drawer covers it — the chord is still consumed
      // (`preventDefault`), it just doesn't do anything.
      if (matchesChord(e, newSessionKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) newSession()
        return
      }
      if (matchesChord(e, newTaskKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) onNewTask()
        return
      }
      if (matchesChord(e, closeSessionKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) closeSession()
        return
      }
      if (matchesChord(e, searchKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) onSearch?.()
        return
      }
      if (matchesChord(e, issuesKey)) {
        e.preventDefault()
        if (store.windowRole === 'secondary') {
          window.octopusAPI.issues.toggleDrawer()
        } else {
          store.toggleIssuesDrawer()
        }
        return
      }
      if (matchesChord(e, splitRightKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) trySplit('row')
        return
      }
      if (matchesChord(e, splitDownKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) trySplit('col')
        return
      }
      if (matchesChord(e, focusPaneLeftKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) focusDirection('left')
        return
      }
      if (matchesChord(e, focusPaneRightKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) focusDirection('right')
        return
      }
      if (matchesChord(e, focusPaneUpKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) focusDirection('up')
        return
      }
      if (matchesChord(e, focusPaneDownKey)) {
        e.preventDefault()
        if (!suppressedByDrawer) focusDirection('down')
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
