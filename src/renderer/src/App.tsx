/**
 * The renderer composition root (DESIGN §5.1, §5.6). It wires the one event
 * subscription and hydrates the store on mount, then lays out this window by ROLE:
 *   - **main** → the left `ProgressPanel` (task list + controls) and the right
 *     `TaskWorkspace` (keep-alive session panes) — the full IDE.
 *   - **secondary** (V1.5) → session-only: no progress panel, just the active
 *     task's sessions that belong to THIS window (`SecondaryWorkspace`).
 *   - **view** (window-view feature) → a window permanently pinned to one task
 *     (`store.viewTaskId`): the left `ProgressPanel` in its `readOnly` mode (every
 *     task listed, but non-interactive — no switching/drag/reorder/create/delete)
 *     plus the SAME `TaskWorkspace` main uses for its session area. Reusing
 *     `TaskWorkspace` unmodified works here because a view window's `activeTaskId`
 *     is pinned to `viewTaskId` (store.ts's `activeTaskChanged` reducer no-ops while
 *     it's set) — so `TaskWorkspace`'s existing "only the active task is laid out,
 *     every other task stays keep-alive-hidden" behavior already shows exactly, and
 *     only, the viewed task's sessions. A thin banner above both panels is the
 *     explicit view indicator (the OS window title is ALSO `<task name> [View]`,
 *     set and kept in sync by the main process alone — `wireViewTitle`,
 *     `src/main/window.ts` — which also blocks Electron's `page-title-updated`
 *     event, so nothing in this renderer, including a stray `document.title`
 *     write, could ever reach the OS title or fight main for ownership of it).
 *     No Issues drawer here (main-only, DESIGN §13.4/§13.5) and no task-creation
 *     shortcut.
 * All three share the `Toaster` and the boot sequence; only the main window mounts
 * the New-Task modal + task-creation shortcut. All real UI lives in `components/`.
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
import { DeleteTaskConfirm } from './components/DeleteTaskConfirm'
import { UpdateAvailableModal } from './components/UpdateAvailableModal'
import { RestartConfirmModal } from './components/RestartConfirmModal'
import { IssuesDrawer } from './components/IssuesDrawer'
import { DebugOverlay } from './components/DebugOverlay'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { color, fontSize } from './style/tokens'

const shellStyle: React.CSSProperties = {
  display: 'flex',
  height: '100vh',
  margin: 0,
  background: 'var(--bg-app)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-sans)'
}

/**
 * Wraps `TaskWorkspace` + `IssuesDrawer` (PRD "Issues" → "Issues window"): the
 * drawer is `position: absolute; inset: 0` against this box, so `position: relative`
 * here scopes it to the session area only, never covering the `ProgressPanel`
 * beside it. `overflow: clip` + `minWidth: 0` keep the drawer's slide-in
 * (`transform`, never `left`/`width`) and the workspace's own content from pushing
 * this flex child wider than the space actually available, without making this
 * element a scroll container: `clip` (Chromium ≥90) clips overflow the same as
 * `hidden` but is never programmatically scrollable, so a `scrollIntoView` call for
 * a row/card still off-screen behind the drawer's in-flight slide transition (e.g.
 * right after the drawer opens with a selection, DESIGN §13.5) can't walk up and
 * scroll THIS ancestor sideways — `hidden` was script-scrollable and did exactly
 * that. Neither this element nor anything else reads its `scrollLeft`/`scrollTop`.
 */
const workspaceAreaStyle: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  display: 'flex',
  minWidth: 0,
  overflow: 'clip'
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
  const loadUpdateStatus = useStore((s) => s.loadUpdateStatus)

  useEffect(() => {
    const unsubscribe = initEventRouting(applyEvent)
    void window.octopusAPI.app.getState().then((state) => {
      hydrate(state)
      // After hydrate so windowRole is known (no popup flash in secondary/view windows).
      void loadUpdateStatus().catch(() => undefined)
      // Kick off restore of the initially-active task's sessions NOW (§6.3): the
      // backend only spawns a restored task's PTYs (and replays their scrollback)
      // inside `switchTask → startTaskSessions`, and nothing else fires a switch at
      // launch. Without this, history for the active task wouldn't appear until the
      // user clicked around. The backend pointer is already this id (set by
      // `Workspace.hydrate`), so this switch skips the pointer move + event and only
      // runs the idempotent session start. Every window issues it (idempotent), so a
      // window opened later still gets its sessions started.
      //
      // Window-view feature: skip this entirely when `viewTaskId` is set (a view or
      // one of its secondaries). The backend already starts a view task's sessions as
      // part of `createView`/window-open, and `state.activeTaskId` there is MAIN's
      // global pointer, not this window's pinned task — issuing `tasks.switch` with it
      // would wrongly move that global pointer out from under main.
      if (state.activeTaskId && state.viewTaskId === undefined)
        void window.octopusAPI.tasks.switch({ taskId: state.activeTaskId })
    })
    return unsubscribe
  }, [hydrate, applyEvent, loadUpdateStatus])
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
  // `null` = closed; `{}` = the plain "+ New Task" button; `{ issueId }` = "Create
  // task" from the Issues drawer (PRD "Issues" → "Issues and tasks"), which locks
  // and prefills `NewTaskModal` via `fromIssueId`.
  const [newTaskFrom, setNewTaskFrom] = useState<{ issueId?: string } | null>(null)
  // Preserve an already-open create-from-issue prefill: the keyboard
  // shortcut and the "+ New Task" button both call this, and while the modal is
  // already open from the Issues drawer with an `issueId` locked in, re-firing
  // either must not clobber it back to the plain, unprefilled `{}` form.
  const openNewTask = useCallback(() => setNewTaskFrom((prev) => prev ?? {}), [])
  useKeyboardShortcuts({ onNewTask: openNewTask, onSearch: openSearchForActive })

  // The bound-task delete flow opened FROM the Issues drawer's own `BoundDeleteDialog`
  // (PRD "Issues" → "Deleting"): the choice is already made there, so `DeleteTaskConfirm`
  // is given a `preset` and skips its own choice step.
  const [boundDelete, setBoundDelete] = useState<{
    taskId: string
    preset: 'task' | 'both'
  } | null>(null)

  const onCreateTaskFromIssue = useCallback((issueId: string) => setNewTaskFrom({ issueId }), [])
  const onDeleteBoundTask = useCallback(
    (taskId: string, alsoDeleteIssue: boolean) =>
      setBoundDelete({ taskId, preset: alsoDeleteIssue ? 'both' : 'task' }),
    []
  )

  const issuesDrawerOpen = useStore((s) => s.issuesDrawerOpen)
  const workspaceWrapperRef = useRef<HTMLDivElement>(null)

  // `inert` is not in @types/react 18.3 — reflect it onto the DOM node directly
  // (mirrors `IssuesDrawer`'s own `inert` effect on itself). While the drawer
  // covers the workspace (`position: absolute; inset: 0` on top of it),
  // the workspace must be neither focusable nor keyboard-reachable underneath it.
  // `TerminalPane` unconditionally calls `term.focus()`
  // on mount and on tab activation; per spec, focusing an element inside an
  // `inert` subtree is a no-op, so this alone neutralizes those calls for any
  // pane currently hidden behind the drawer — no change needed inside
  // `TerminalPane` itself. `aria-hidden` additionally pulls the whole subtree out
  // of the accessibility tree while it's covered.
  useEffect(() => {
    const el = workspaceWrapperRef.current
    if (!el) return
    ;(el as HTMLElement & { inert: boolean }).inert = issuesDrawerOpen
  }, [issuesDrawerOpen])

  return (
    <main style={shellStyle}>
      <ProgressPanel onNewTask={openNewTask} />
      <div style={workspaceAreaStyle}>
        <div
          ref={workspaceWrapperRef}
          aria-hidden={issuesDrawerOpen}
          style={{ display: 'flex', flex: 1, minWidth: 0 }}
        >
          <TaskWorkspace />
        </div>
        <IssuesDrawer
          onCreateTaskFromIssue={onCreateTaskFromIssue}
          onDeleteBoundTask={onDeleteBoundTask}
        />
      </div>
      <Toaster />
      <DebugOverlay />
      {/* Rendered as a sibling OUTSIDE `workspaceAreaStyle`/the drawer, not nested
          inside it: the drawer's slide-in `transform` would otherwise make it the
          containing block for these `position: fixed` overlays (`overlayStyle`),
          confining them to the session area instead of the whole window — and its
          `zIndex: 40` is already below `overlayStyle`'s 100, so no overlap either way. */}
      {newTaskFrom ? (
        <NewTaskModal fromIssueId={newTaskFrom.issueId} onClose={() => setNewTaskFrom(null)} />
      ) : null}
      {boundDelete ? (
        <DeleteTaskConfirm
          key={boundDelete.taskId}
          taskId={boundDelete.taskId}
          preset={boundDelete.preset}
          onClose={() => setBoundDelete(null)}
          onDone={() => setBoundDelete(null)}
        />
      ) : null}
      {/* Self-update modals (main window only). After ProgressPanel (which mounts
          SettingsModal) in DOM order so the restart confirm paints above Settings. */}
      <UpdateAvailableModal />
      <RestartConfirmModal />
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

/**
 * A view window (window-view feature, §5.1 of the window-view design doc): pinned
 * permanently to one task (`store.viewTaskId`). Layout mirrors `MainWindowApp` minus
 * the Issues drawer and task-creation shortcut — see the module doc comment for why
 * `ProgressPanel readOnly` + the unmodified `TaskWorkspace` are the right reuse here.
 */
function ViewWindowApp(): React.JSX.Element {
  // Only the search shortcut is meaningful here; task creation/Issues live in main.
  useKeyboardShortcuts({ onNewTask: () => {}, onSearch: openSearchForActive })

  const viewTaskId = useStore((s) => s.viewTaskId)
  const taskName = useStore((s) => (viewTaskId ? s.tasks[viewTaskId]?.name : undefined))

  return (
    <main style={{ ...shellStyle, flexDirection: 'column' }}>
      {/* Explicit view indicator (product spec: "a clear view indicator... near the
          task bar"). The OS window title already carries `<task name> [View]` — set
          and exclusively owned by the main process (`wireViewTitle`, src/main/window.ts,
          which also blocks `page-title-updated` so nothing else can overwrite it) — so
          this banner is purely an in-page reinforcement, not the source of truth. */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 12px',
          background: color.infoBg,
          color: color.infoText,
          fontSize: fontSize.sm,
          borderBottom: `1px solid ${color.border}`
        }}
      >
        <span style={{ fontWeight: 700 }}>View</span>
        {taskName ? <span>— {taskName}</span> : null}
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <ProgressPanel onNewTask={() => {}} readOnly />
        <TaskWorkspace />
      </div>
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
  if (windowRole === 'secondary') return <SecondaryWindowApp />
  if (windowRole === 'view') return <ViewWindowApp />
  return <MainWindowApp />
}
