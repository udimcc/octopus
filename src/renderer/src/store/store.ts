/**
 * The renderer's single source of truth (DESIGN §5.2). It is a *projection* of
 * backend state, never an authority: it is filled once by `hydrate(getState())`
 * on startup and thereafter patched by `applyEvent(EventDTO)` as the backend
 * streams changes. Commands are dispatched through `window.octopusAPI` and their
 * effects come back as events — the store is not mutated optimistically.
 *
 * Shape is NORMALIZED: `sessions` is the flat source of truth for session data,
 * and each task carries an ordered `sessionIds`. That keeps updates O(1) and
 * avoids the drift a duplicated nested copy would invite.
 *
 * CRITICAL (§5.2/§5.3): `ptyData` never enters the store. High-frequency terminal
 * output is routed straight to the xterm instance by `pty-router`; `applyEvent`
 * ignores it defensively so a stray call can't churn React state at 60Hz.
 */

import { create } from 'zustand'
import { createNotificationThrottle } from './notification-throttle'
import type {
  WindowedWorkspaceStateDTO,
  TaskDTO,
  SessionDTO,
  SessionTypeDTO,
  SettingsDTO,
  WorktreeRefDTO,
  WindowDTO,
  WindowRole,
  IssueDTO,
  GroupDTO,
  JiraFiltersDTO
} from '../../../shared/dto'
import type { EventDTO } from '../../../shared/events'
import { type DisplayState, DISPLAY_RANK } from './display-state'
import { leafIds, hasLeaf } from './split-layout'

/** Normalized task record: task-level metadata + an ordered list of session ids. */
export interface TaskEntry {
  readonly id: string
  readonly name: string
  readonly worktree?: WorktreeRefDTO
  /** A "No Repo" task (§5.4): no worktree, groups under "No Repository". */
  readonly repoLess?: boolean
  readonly lifecycle: string
  readonly state: string
  readonly sessionIds: readonly string[]
  readonly activeSessionId?: string
  readonly position: number
  readonly createdAt: number
}

export type ToastKind = 'info' | 'error'

export interface Toast {
  readonly id: number
  readonly kind: ToastKind
  /** Optional bold heading rendered above `message` (e.g. "State changed" for §9.5). */
  readonly title?: string
  readonly message: string
}

/**
 * One entry in the keyboard-toggled debug overlay's ring (§11). A pure renderer
 * view-model of the `sessionStateChanged` stream — the deciding-signal metadata
 * (layer/confidence/reason) the backend forwards, kept only for on-screen
 * diagnostics. Not persisted, not part of any DTO. `seq` is a monotonic id
 * (no wall clock in the reducer) so React keys stay stable and order is total.
 */
export interface DebugTransition {
  readonly seq: number
  readonly sessionId: string
  readonly from: string
  readonly to: string
  readonly layer?: 1 | 2 | 3
  readonly confidence?: string
  readonly reason?: string
}

/** How many transitions the overlay ring retains (newest wins; oldest evicted). */
export const DEBUG_RING_CAPACITY = 200

/** The plain data the store holds (no actions) — the unit the reducer operates on. */
export interface StoreData {
  readonly tasks: Readonly<Record<string, TaskEntry>>
  readonly sessions: Readonly<Record<string, SessionDTO>>
  readonly taskOrder: readonly string[]
  readonly activeTaskId?: string
  /**
   * How many of THIS window's optimistic task switches ({@link StoreActions.setActiveTask})
   * are still awaiting their `tasks.switch` reply. While non-zero, `activeTaskChanged` is
   * ignored: those events are echoes of our own earlier switches, and applying them under
   * the newer local pick flickers back through each intermediate task (A→C→B→C when
   * cycling A→B→C fast). Each request's event is sent before its reply, so when the
   * count drops to 0 every echo has arrived, and the backend pointer equals the local pick.
   */
  readonly inFlightTaskSwitches: number
  /**
   * task id → THIS window's marked session tab: the one this window displays when that
   * task is active (DESIGN §3.7, §5.4). PER-WINDOW, not replicated: each renderer keeps
   * its own mark, so switching to a session hosted in another window leaves this window
   * still showing (and marking) what it had. Invariant: the mark is a session of that
   * task hosted in THIS window, or absent (this window hosts none of its sessions).
   * Readers go through {@link activeSessionInWindow}, which also guards the invariant.
   * Renderer-only — the backend's `task.activeSessionId` is the persisted "last focused
   * session" (the focused window's mark), used to seed marks on hydrate.
   */
  readonly activeSessionByTask: Readonly<Record<string, string>>
  /**
   * Each task's split-pane groups (DESIGN §5.7, split-groups design), as last received
   * from the backend: `TaskDTO.groups` on `hydrate`/`taskCreated`, replaced wholesale on
   * `groupsChanged`. The renderer never mutates a group — it sends ids in commands
   * (`window.octopusAPI.groups.join/leave/ungroup/reorder/resize`) and the backend's reply
   * arrives as the same `groupsChanged` event. A session absent from every group of its
   * task is lone. See {@link groupOfSession}.
   */
  readonly groupsByTask: Readonly<Record<string, readonly GroupDTO[]>>
  readonly sessionTypes: readonly SessionTypeDTO[]
  readonly settings: SettingsDTO
  readonly version: number
  readonly toasts: readonly Toast[]
  /** Monotonic toast id source (kept in state so it survives without Date/random). */
  readonly nextToastId: number
  /** Which window this renderer is (V1.5, §5.6); filters the session view. */
  readonly windowId: string
  /**
   * `main` → owns the progress panel; `secondary` → session-only; `view` → pinned to
   * one task (window-view feature), with the progress panel read-only (all tasks
   * grayed out except the viewed one).
   */
  readonly windowRole: WindowRole
  /** All open windows (V1.5, §6.7); patched by window lifecycle events. */
  readonly windows: readonly WindowDTO[]
  /**
   * Set for a `view` window AND for any `secondary` parented to one (window-view
   * feature) — NOT keyed on `windowRole === 'view'` alone, since a view's own
   * secondary keeps `windowRole: 'secondary'` but is still permanently pinned to the
   * same task. The task this window's GROUP is pinned to, hydrated from
   * {@link WindowedWorkspaceStateDTO.viewTaskId}. `activeTaskId` is kept fixed to this
   * value — the `activeTaskChanged` reducer no-ops while it is set (defensive; main
   * already never sends the event to a view window or its secondaries), and
   * {@link StoreActions.setActiveTask} no-ops too, so no local "switch task" path can
   * move either off its pinned task.
   */
  readonly viewTaskId?: string
  /**
   * "Unseen finished turn" memory (§9.5): session id → true once it went `Working →
   * Waiting` (a turn finished) and hasn't been looked at since. Raised
   * UNCONDITIONALLY on that transition — the on-screen decision is made LATER, at
   * display time (see `sessionDisplayState`), because on the VDI/SwiftShader host the
   * focus signal is briefly unreliable at the finish instant (§9.7). Cleared when the
   * user brings the session on screen (a focus transition) or it leaves `Waiting`. A
   * pure renderer view-model derived from the `sessionStateChanged` stream — NOT a
   * domain state, not persisted, not in any DTO. Absent/false → no finished-unseen turn.
   */
  readonly hasUnseenFinishedTurn: Readonly<Record<string, boolean>>
  /**
   * Whether THIS window currently has OS focus (§9.5). A session in a blurred window
   * counts as not-on-screen, so at display time its finished-unseen turn shows the
   * review dot even if it is the active tab. Patched by `App`'s focus/blur listeners;
   * defaults true.
   */
  readonly windowFocused: boolean
  /**
   * Whether this window has ever had OS focus. Its FIRST focus gain (the window appearing)
   * does not flash the marked tab (§5.4) — only moving back into an already-seen window does.
   */
  readonly windowFocusedOnce: boolean
  /**
   * Rolling ring of recent state transitions for the debug overlay (§11), newest
   * last, capped at {@link DEBUG_RING_CAPACITY}. Populated from every
   * `sessionStateChanged` event regardless of overlay visibility, so opening it
   * shows immediate history.
   */
  readonly debugTransitions: readonly DebugTransition[]
  /** Monotonic sequence source for {@link DebugTransition.seq} (survives without a clock). */
  readonly nextDebugSeq: number
  /** Whether the debug overlay is currently shown in THIS window (keyboard-toggled). */
  readonly debugOverlayOpen: boolean
  /**
   * Focus flash (§5.4): while `focusFlashOn`, the marked tab of the active task gets a
   * one-shot accent fade so the user can tell which session is focused after moving to
   * this window (its mark may not have changed at all). Armed when this window GAINS OS
   * focus (except its first-ever gain, see {@link windowFocusedOnce}), or when a switch lands on a session hosted here while still unfocused (the
   * raise's focus event may trail the `activeSessionChanged` event). Turned off by blur
   * or by `endFocusFlash` after {@link FOCUS_FLASH_MS}. Whichever tab is marked while it is
   * on carries the class, so a mark that moves mid-flash moves the flash with it.
   * `focusFlashSeq` identifies the current flash so a stale expiry timer is ignored.
   */
  readonly focusFlashOn: boolean
  readonly focusFlashSeq: number
  /** All locally-tracked issues ("Issues"), keyed by id — a projection of `WorkspaceStateDTO.issues`. */
  readonly issues: Readonly<Record<string, IssueDTO>>
  /**
   * Whether the Issues drawer is open in THIS window ("Issues"). Renderer-local
   * view-state, NEVER persisted and NEVER sent over the wire: it starts closed on
   * every launch and survives a `hydrate()` re-hydration (see {@link useStore.hydrate}).
   */
  readonly issuesDrawerOpen: boolean
  /**
   * Which pane the drawer's left side shows ("Issues" → Board, DESIGN §13.5): `'list'`
   * (grouped-by-status rows) or `'board'` (the Kanban columns). Renderer-local view-state,
   * NEVER persisted and NEVER sent over the wire — like {@link issuesDrawerOpen} it starts
   * on `'list'` every launch (PRD "Issues": "List after a restart") and survives a
   * `hydrate()` re-hydration. Closing/reopening the drawer and selecting an issue from a
   * task row (`openIssuesDrawer`) both leave it untouched, so the drawer reopens on
   * whichever tab the user last used (DESIGN §13.5).
   */
  readonly issuesDrawerTab: IssuesDrawerTab
  /** The issue shown in the drawer's right pane, if any. Renderer-local view-state. */
  readonly selectedIssueId?: string
  /**
   * True while the right pane shows an unsaved "+ New Issue" draft (no `selectedIssueId`
   * yet — the issue doesn't exist until Save). Renderer-local view-state.
   */
  readonly issueDraft: boolean
  /** True while the right pane has unsaved edits (existing issue or draft). Renderer-local view-state. */
  readonly issueEditDirty: boolean
  /**
   * The action the drawer is about to perform, held back by {@link issueEditDirty} until
   * the user confirms discarding ("Discard unsaved changes?"). `null` when no prompt is
   * showing. Renderer-local view-state.
   */
  readonly discardPrompt: DiscardPendingAction | null
  /**
   * Bumped on every REAL change to what the drawer's right pane is editing: a
   * resolved selection change, a fresh draft start, or a discard that lands on one
   * of those (even when the before/after `selectedIssueId`/`issueDraft` pair comes
   * out unchanged — e.g. re-picking the issue already shown, or discarding a draft
   * back into a fresh draft). `IssueDetail` keys its field-reset effect on this
   * counter instead of on `[selectedIssueId, issueDraft]`, which doesn't change in
   * those cases and so would otherwise leave stale text on screen.
   * Renderer-local view-state; survives `hydrate()` like the other drawer fields.
   */
  readonly issueEditSession: number
  /**
   * Whether the Settings modal is open in THIS window. Renderer-local view-state, like
   * {@link issuesDrawerOpen}: NEVER persisted and NEVER sent over the wire, starts closed
   * on every launch, and survives a `hydrate()` re-hydration (see {@link useStore.hydrate}).
   */
  readonly settingsOpen: boolean
}

/**
 * A drawer action deferred behind the "Discard unsaved changes?" prompt while
 * {@link StoreData.issueEditDirty} is set: closing the drawer, selecting a different
 * issue, or starting a new one. `confirmDiscard` performs it; `cancelDiscard` drops it.
 */
export type DiscardPendingAction =
  | { readonly kind: 'close' }
  | { readonly kind: 'select'; readonly issueId: string }
  | { readonly kind: 'new' }

/** Which pane the Issues drawer shows ("Issues" → Board, DESIGN §13.5). See {@link StoreData.issuesDrawerTab}. */
export type IssuesDrawerTab = 'list' | 'board'

/** Duration of the focus flash (§5.4). Keep in sync with `.session-tab--focus-flash` in globals.css. */
export const FOCUS_FLASH_MS = 1000

export interface StoreActions {
  hydrate(state: WindowedWorkspaceStateDTO): void
  applyEvent(event: EventDTO): void
  setActiveTask(taskId: string): void
  /** The `tasks.switch` request paired with a {@link setActiveTask} has settled. */
  taskSwitchSettled(): void
  setActiveSession(taskId: string, sessionId: string): void
  /**
   * Optimistically flip the group-by-repo view preference in place (§5.1). The
   * caller persists it via `app.updateSettings`; unlike the SettingsModal we do
   * NOT re-hydrate the whole workspace for a one-click view toggle (that would
   * reset toasts), so this patches just the one settings field.
   */
  setGroupTasksByRepo(value: boolean): void
  /**
   * Optimistically patch `settings.jira.lastFilters` in place (DESIGN §13.7), same pattern
   * as {@link setGroupTasksByRepo}: the Jira Import modal calls `app.updateSettings` itself
   * to persist it, so reopening the modal prefills from this local copy without a
   * round-trip re-hydrate.
   */
  setJiraLastFilters(filters: JiraFiltersDTO): void
  pushToast(kind: ToastKind, message: string): void
  dismissToast(id: number): void
  /**
   * Record this window's OS focus (§9.5). Gaining it flashes the marked tab (§5.4); the
   * "looked at" ready-for-review clear is left to `markVisibleSessionSeen`.
   */
  setWindowFocused(focused: boolean): void
  /**
   * "Watched it finish in place" clear (§9.5). A session that finishes (Working → Idle)
   * while it is ALREADY the on-screen tab fires no focus *transition*, so none of the
   * transition-based clears mark it seen — and the review dot would then surface the
   * moment the user switches away from a session they watched finish. This clears the
   * finished-unseen flag for THIS window's currently on-screen session (via the same
   * `isSessionFocused` predicate the display uses). Driven by an effect on every settled
   * render (App), so it reads the reliable present-time focus, never the flaky finish
   * instant (§9.7). No-op unless the visible session is flagged. Returns the session
   * id it just cleared (or `undefined` if nothing cleared) so the caller can relay the
   * "seen" cross-window via `sessions.markSeen` — a turn finished in place fires no
   * focus transition, so the OTHER windows (esp. the main window's task rollup, which
   * folds over sessions in any window) can't learn it was seen any other way (§9.5).
   * It is also the ONLY "looked at" clear for a task switch and a window focus gain:
   * with per-window marks only the focused window knows which session is on screen.
   */
  markVisibleSessionSeen(): string | undefined
  /** Toggle the keyboard-triggered debug overlay for this window (§11). */
  toggleDebugOverlay(): void
  /** End focus flash `seq` (§5.4); ignored if a newer flash has started since. */
  endFocusFlash(seq: number): void
  /**
   * Open/close the Issues drawer in THIS window ("Issues"). Opening is unconditional.
   * Closing is dirty-guarded: while {@link StoreData.issueEditDirty}, it raises
   * {@link StoreData.discardPrompt} (`{kind:'close'}`) instead of closing. A successful
   * close also clears {@link StoreData.issueDraft}. Shared with the `issuesDrawerToggle`
   * wire event (the main-window relay from a secondary window's shortcut) via the same
   * pure {@link toggleDrawerData}.
   */
  toggleIssuesDrawer(): void
  /**
   * Open the drawer. If already open and `issueId` is given, behaves like
   * `selectIssue(issueId)` (dirty-guarded). If closed, opens directly onto `issueId`
   * (or keeps the previous selection if omitted) — no dirty state can exist while closed.
   */
  openIssuesDrawer(issueId?: string): void
  /**
   * Switch the drawer's List/Board pane ("Issues" → Board, DESIGN §13.5). Never
   * dirty-guarded: both panes share one selection (DESIGN §13.5), so a tab switch can
   * never raise `discardPrompt` and never touches
   * `selectedIssueId`/`issueDraft`/`issueEditDirty`.
   */
  setIssuesDrawerTab(tab: IssuesDrawerTab): void
  /** Select an issue in the drawer. Dirty-guarded: raises `discardPrompt {kind:'select', issueId}`. */
  selectIssue(id: string): void
  /** Start a "+ New Issue" draft. Dirty-guarded: raises `discardPrompt {kind:'new'}`. */
  startNewIssue(): void
  /** Mark the drawer's current edit (existing issue or draft) dirty/clean. */
  setIssueEditDirty(dirty: boolean): void
  /** Perform the pending `discardPrompt` action, discarding the dirty edit, and clear the prompt. */
  confirmDiscard(): void
  /** Drop the pending `discardPrompt` without acting ("Keep editing"). */
  cancelDiscard(): void
  /**
   * Discard the "+ New Issue" draft directly ("Issues", `IssueDetail`'s own draft
   * Cancel button). Unlike `toggleIssuesDrawer`/`selectIssue`/`startNewIssue`, this is
   * never dirty-guarded: an explicit Cancel click already means "discard", so it
   * never raises `discardPrompt`. Leaves `issuesDrawerOpen` and `selectedIssueId`
   * untouched — the draft never had a `selectedIssueId` to begin with. Bumps
   * `issueEditSession` like every other draft-ending path, so a late create reply
   * for the cancelled draft is ignored rather than selecting the created issue.
   */
  cancelNewIssue(): void
  /**
   * Focus a pane (DESIGN §5.7, split-groups design) by session id alone (a pane click, a
   * focus-pane chord): moves this window's mark like {@link StoreActions.setActiveSession},
   * but deliberately WITHOUT its local ready-for-review clear — the moved mark re-runs
   * `markVisibleSessionSeen`, which clears and relays "seen" to every window (§9.5). A pure
   * mark move — it never touches a group; the backend owns groups.
   */
  focusPane(sessionId: string): void
  /** Open the Settings modal in THIS window. Renderer-local view-state. */
  openSettings(): void
  /** Close the Settings modal in THIS window. Renderer-local view-state. */
  closeSettings(): void
}

export type Store = StoreData & StoreActions

const DEFAULT_SETTINGS: SettingsDTO = {
  worktree: { location: '' },
  terminal: {},
  defaultSessionTypeId: 'terminal',
  groupTasksByRepo: true,
  sessionNextKey: 'Ctrl+Shift+ArrowRight',
  sessionPrevKey: 'Ctrl+Shift+ArrowLeft',
  taskNextKey: 'Ctrl+Shift+ArrowDown',
  taskPrevKey: 'Ctrl+Shift+ArrowUp',
  newSessionKey: 'Ctrl+Shift+KeyN',
  newTaskKey: 'Ctrl+Shift+KeyT',
  closeSessionKey: 'Ctrl+Shift+KeyW',
  searchKey: 'Ctrl+Shift+KeyF',
  copyKey: 'Ctrl+Shift+KeyC',
  pasteKey: 'Ctrl+Shift+KeyV',
  issuesKey: 'Alt+Shift+KeyI',
  splitRightKey: 'Ctrl+Shift+KeyE',
  splitDownKey: 'Ctrl+Shift+KeyO',
  focusPaneLeftKey: 'Ctrl+Shift+KeyH',
  focusPaneRightKey: 'Ctrl+Shift+KeyL',
  focusPaneUpKey: 'Ctrl+Shift+KeyK',
  focusPaneDownKey: 'Ctrl+Shift+KeyJ'
}

/** The empty projection before hydration (also used to reset the store in tests). */
export function initialData(): StoreData {
  return {
    tasks: {},
    sessions: {},
    taskOrder: [],
    activeTaskId: undefined,
    inFlightTaskSwitches: 0,
    activeSessionByTask: {},
    groupsByTask: {},
    sessionTypes: [],
    settings: DEFAULT_SETTINGS,
    version: 1,
    toasts: [],
    nextToastId: 1,
    // Default to the main window until hydration stamps this renderer's identity
    // (V1.5, §5.6). A pre-hydration render shows the main-window layout.
    windowId: 'main',
    windowRole: 'main',
    windows: [],
    hasUnseenFinishedTurn: {},
    windowFocused: true,
    windowFocusedOnce: false,
    debugTransitions: [],
    nextDebugSeq: 1,
    debugOverlayOpen: false,
    focusFlashOn: false,
    focusFlashSeq: 0,
    issues: {},
    issuesDrawerOpen: false,
    issuesDrawerTab: 'list',
    selectedIssueId: undefined,
    issueDraft: false,
    issueEditDirty: false,
    discardPrompt: null,
    issueEditSession: 1,
    settingsOpen: false
  }
}

/** Project a wire TaskDTO into the normalized {entry, sessions[]} pair. */
function normalizeTask(dto: TaskDTO): { entry: TaskEntry; sessions: SessionDTO[] } {
  const sessions = [...dto.sessions].sort((a, b) => a.order - b.order)
  const entry: TaskEntry = {
    id: dto.id,
    name: dto.name,
    worktree: dto.worktree,
    repoLess: dto.repoLess,
    lifecycle: dto.lifecycle,
    state: dto.state,
    sessionIds: sessions.map((s) => s.id),
    activeSessionId: dto.activeSessionId,
    position: dto.position,
    createdAt: dto.createdAt
  }
  return { entry, sessions }
}

/**
 * Choose a window's mark (§3.7): the first candidate hosted in this window, else the
 * window's first hosted tab, else `undefined` (it hosts none of the task's sessions).
 */
function pickMark(
  hosted: readonly string[],
  ...candidates: readonly (string | undefined)[]
): string | undefined {
  for (const c of candidates) {
    if (c && hosted.includes(c)) return c
  }
  return hosted[0]
}

/**
 * Set (or, for `undefined`, drop) this window's mark for a task; identity when unchanged.
 * A pure mark move — it NEVER touches a group (DESIGN §5.7, split-groups design): the
 * backend owns groups, and moving the mark to a grouped session just focuses that pane
 * within whatever group it already belongs to (or shows it alone if it is lone). Every
 * mark-setting call site funnels through here (the two exceptions, `hydrateData` and
 * `taskDeleted`'s teardown, pick the mark directly because there is no "old mark" to
 * compare against).
 */
function withMark(data: StoreData, taskId: string, sessionId: string | undefined): StoreData {
  if (data.activeSessionByTask[taskId] === sessionId) return data
  if (sessionId === undefined) {
    return { ...data, activeSessionByTask: omit(data.activeSessionByTask, taskId) }
  }
  return { ...data, activeSessionByTask: { ...data.activeSessionByTask, [taskId]: sessionId } }
}

/**
 * The nearest entry to `index` in `list` that is NOT in `exclude` (right first, else
 * left) — used by the `sessionMovedToWindow` IMP1 fix to re-mark a tab outside a whole
 * moving group rather than a structurally-adjacent one that might be a groupmate also
 * about to leave. `undefined` if every other entry is excluded (drop the mark).
 */
function nearestOutside(
  list: readonly string[],
  index: number,
  exclude: ReadonlySet<string>
): string | undefined {
  for (let j = index + 1; j < list.length; j++) {
    if (!exclude.has(list[j])) return list[j]
  }
  for (let j = index - 1; j >= 0; j--) {
    if (!exclude.has(list[j])) return list[j]
  }
  return undefined
}

/** Start a new focus flash (§5.4). */
function armFlash(data: StoreData): StoreData {
  return { ...data, focusFlashOn: true, focusFlashSeq: data.focusFlashSeq + 1 }
}

/**
 * Project a workspace snapshot into this window's store. Each task's mark (§3.7) is the
 * previous mark if still hosted here (a SettingsModal re-hydrate must not reset what each
 * window shows), else `state.initialMark`'s session if it names THIS task and is hosted
 * here (IMP2 fix — a window created to show a detached session, §6.7
 * `windows.createWithSession`, must open ON that session rather than the task's persisted
 * last-focused one), else the persisted last-focused session if hosted here, else this
 * window's first hosted tab. Groups travel inside the task DTO (DESIGN §5.7, split-groups
 * design) — there is no separate layout channel to prune or reconcile; the backend is
 * authoritative and already enforces its invariants, so `groupsByTask` is just the DTO's
 * `groups` per task, as-is.
 *
 * `activeTaskId` comes from `state.viewTaskId ?? state.activeTaskId` (the view pin wins;
 * never from `initialMark`): a
 * renderer crash-reload (`window.ts`'s `render-process-gone`) re-runs this hydrate with no
 * prior state, and overriding the active task here would yank the window back to the
 * detach-time task even if the user had since switched away from it. `initialMark` only
 * ever feeds `pickMark` above, scoped to its own task.
 */
function hydrateData(
  state: WindowedWorkspaceStateDTO,
  prevMarks: Readonly<Record<string, string>> = {}
): StoreData {
  const base = initialData()
  const tasks: Record<string, TaskEntry> = {}
  const sessions: Record<string, SessionDTO> = {}
  const activeSessionByTask: Record<string, string> = {}
  const groupsByTask: Record<string, readonly GroupDTO[]> = {}
  const initialMark = state.initialMark

  const ordered = [...state.tasks].sort((a, b) => a.position - b.position)
  for (const t of ordered) {
    const { entry, sessions: ss } = normalizeTask(t)
    tasks[entry.id] = entry
    for (const s of ss) sessions[s.id] = s
    groupsByTask[entry.id] = t.groups
    const hosted = ss.filter((s) => s.windowId === state.thisWindowId).map((s) => s.id)
    const initialMarkSessionId =
      initialMark && initialMark.taskId === entry.id ? initialMark.sessionId : undefined
    const mark = pickMark(hosted, prevMarks[entry.id], initialMarkSessionId, entry.activeSessionId)
    if (mark) activeSessionByTask[entry.id] = mark
  }

  const issues: Record<string, IssueDTO> = {}
  for (const issue of state.issues) issues[issue.id] = issue

  return {
    ...base,
    tasks,
    sessions,
    taskOrder: ordered.map((t) => t.id),
    // A view window is pinned to its one task (window-view feature): its active
    // task is always `viewTaskId`, never the backend's generic `activeTaskId` (which
    // tracks main's own last-active task and is irrelevant here).
    activeTaskId: state.viewTaskId ?? state.activeTaskId,
    activeSessionByTask,
    groupsByTask,
    sessionTypes: state.sessionTypes,
    settings: state.settings,
    version: state.version,
    windowId: state.thisWindowId,
    windowRole: state.thisWindowRole,
    windows: state.windows,
    viewTaskId: state.viewTaskId,
    issues
  }
}

/**
 * The task's session ids that belong to a given window (V1.5, §5.6), in tab order.
 * A window renders only `session.windowId === windowId`; this is the per-window
 * projection both `TaskView` (panes) and `SessionTabBar` (tabs) filter through so a
 * session moved out unmounts here and one moved in mounts.
 */
export function sessionIdsInWindow(
  data: StoreData,
  taskId: string,
  windowId: string
): readonly string[] {
  const task = data.tasks[taskId]
  if (!task) return []
  return task.sessionIds.filter((id) => data.sessions[id]?.windowId === windowId)
}

/**
 * The session to show (and mark) for a task IN this window (§3.7): this window's mark,
 * defensively falling back to its first hosted tab should the mark ever not be hosted
 * here. `undefined` → this window hosts none of the task's sessions (renders an empty
 * pane area). The single resolver every reader goes through — tab bar, pane stack,
 * `isSessionFocused`, keyboard shortcuts, search — so they always agree.
 */
export function activeSessionInWindow(
  data: StoreData,
  taskId: string,
  windowId: string
): string | undefined {
  const ids = sessionIdsInWindow(data, taskId, windowId)
  const active = data.activeSessionByTask[taskId]
  if (active && ids.includes(active)) return active
  return ids[0]
}

/**
 * The group `sessionId` belongs to within `taskId`'s groups (DESIGN §5.7, split-groups
 * design), or `undefined` if it is lone. Membership is the group's layout tree's leaves —
 * there is no separate member list to go out of sync.
 */
export function groupOfSession(
  data: StoreData,
  taskId: string,
  sessionId: string
): GroupDTO | undefined {
  const groups = data.groupsByTask[taskId]
  if (!groups) return undefined
  return groups.find((g) => hasLeaf(g.layout, sessionId))
}

/**
 * Is `sessionId` currently FOCUSED from this renderer's vantage (§9.5)? True only
 * when it is the session actually ON SCREEN: its task is the active task, it is this
 * window's marked tab for that task, it is hosted in THIS window, and this window has
 * OS focus. A
 * session whose task is not the viewed task (some other `activeTaskId` is on screen),
 * or that lives in another window, or when this window is blurred, or that isn't its
 * task's active tab, counts as unfocused — so a `Working → Waiting` there raises
 * ready-for-review. Only one task is visible per window at a time, so being the active
 * tab of a NON-active task is not "looked at": without the `activeTaskId` check a
 * session finishing while the user views a different task would wrongly be suppressed.
 * Each renderer knows its own OS focus only; that is exactly the per-window view
 * memory §9.5 describes.
 */
export function isSessionFocused(data: StoreData, sessionId: string): boolean {
  const session = data.sessions[sessionId]
  if (!session) return false
  if (!data.windowFocused) return false
  if (session.windowId !== data.windowId) return false
  if (data.activeTaskId !== session.taskId) return false
  return activeSessionInWindow(data, session.taskId, data.windowId) === sessionId
}

/**
 * The issue bound to `taskId`, if any ("Issues"). The binding is stored only on the
 * issue (I19); this is the reverse lookup every reader (task row icon, delete-task
 * flow, New-Task modal) goes through rather than scanning `issues` itself.
 */
export function issueForTask(data: StoreData, taskId: string): IssueDTO | undefined {
  for (const issue of Object.values(data.issues)) {
    if (issue.taskId === taskId) return issue
  }
  return undefined
}

/**
 * Is `issue` bound to a task OTHER than `taskId` ("Issues")? Drives the "already
 * linked" graying in `LinkTaskPicker` and the New-Task modal's issue picker.
 * An issue bound to `taskId` itself (or unbound) is not "elsewhere".
 */
export function isIssueBoundElsewhere(issue: IssueDTO, taskId?: string): boolean {
  return issue.taskId !== undefined && issue.taskId !== taskId
}

// ── Window groups (window-view feature) ───────────────────────────────────────

/**
 * The renderer's own id for the main window. Mirrors the domain's `MAIN_WINDOW_ID`
 * (`domain/ids.ts`) in wire-string form — the renderer may not import `domain` (and
 * `application`'s own `windowGroupRoot`/`viewForTask` helpers, `application/use-cases/
 * window-groups.ts`, work over branded `WindowRecord[]`, not the wire `WindowDTO[]`
 * this module holds), so the small amount of logic is duplicated here rather than
 * shared across the boundary.
 */
const MAIN_WINDOW_ID = 'main'

/** The task's dedicated view window, if one exists (window-view feature; at most one per task). */
export function viewWindowForTask(data: StoreData, taskId: string): WindowDTO | undefined {
  return data.windows.find((w) => w.role === 'view' && w.taskId === taskId)
}

/**
 * Whether `taskId` currently has a dedicated view window open (window-view feature).
 * Drives the disabled "New Window From Task" menu item ("can't open a second view
 * for the same task") — any OTHER "is this task viewed/off-limits HERE" decision
 * should go through {@link isViewedElsewhere} instead, which is group-aware.
 */
export function isViewedTask(data: StoreData, taskId: string): boolean {
  return viewWindowForTask(data, taskId) !== undefined
}

/**
 * `windowId`'s window-GROUP root (window-view feature, DESIGN): itself if it names a
 * `view`; its `parentWindowId` if it names a secondary parented to a STILL-OPEN view;
 * `MAIN_WINDOW_ID` otherwise — covers main itself, every one of main's (parent-less)
 * secondaries, an unknown/not-yet-tracked window id, and a secondary whose parent view
 * has since closed. Mirrors the application layer's `windowGroupRoot` one-for-one, just
 * over `WindowDTO[]` instead of persisted `WindowRecord[]`.
 */
export function windowGroupRoot(data: StoreData, windowId: string): string {
  const record = data.windows.find((w) => w.id === windowId)
  if (!record) return MAIN_WINDOW_ID
  if (record.role === 'view') return record.id
  if (record.parentWindowId !== undefined) {
    const parent = data.windows.find((w) => w.id === record.parentWindowId)
    if (parent?.role === 'view') return parent.id
  }
  return MAIN_WINDOW_ID
}

/** Whether windows `a` and `b` belong to the same window group (window-view feature). */
export function sameWindowGroup(data: StoreData, a: string, b: string): boolean {
  return windowGroupRoot(data, a) === windowGroupRoot(data, b)
}

/**
 * Is `taskId` viewed in a window OUTSIDE THIS window's own group (window-view
 * feature)? True exactly when the task has a dedicated view AND this window
 * (`data.windowId`) is not part of that view's group — covers main, main's
 * secondaries, and any other view's windows. False from INSIDE the task's own
 * view (and its secondaries parented to it): the task's sessions live right here,
 * so session creation/the empty-state overlay must behave normally there. This is
 * the group-based replacement for the earlier `windowRole === 'main'` checks —
 * those wrongly left a view's OWN secondary (which keeps `windowRole: 'secondary'`,
 * pinned via `viewTaskId`) treated as if it could never be "elsewhere", which
 * happened to be harmless for THIS task but gave the wrong answer in general.
 * Drives the disabled "+ New Session" controls (`SessionTabBar`), the
 * `TaskWorkspace`/`SecondaryWorkspace` empty-state overlays, the new-session
 * keyboard shortcut's no-op, and the "Viewing in window" badge (shown only when
 * `true` — never inside the view's own list, where it would be redundant).
 */
export function isViewedElsewhere(data: StoreData, taskId: string): boolean {
  const view = viewWindowForTask(data, taskId)
  if (!view) return false
  return windowGroupRoot(data, data.windowId) !== view.id
}

/**
 * The display level ONE session contributes to its own icon and its task's rollup
 * (§3.4/§9.5). Folds the "unseen finished turn" memory into the state priority via a
 * single ordering. Two CRITICAL display-time gates decide `review`:
 * - STATE gate: `review` is valid ONLY while the session's CURRENT aggregation state
 *   is `waiting` (idle). A `working`/`blocked` session ignores any (possibly stale)
 *   flag, so a newer `working` supersedes a raised-but-unconsumed review — a session
 *   that just finished and then resumed shows `working`, not the stable review dot.
 * - ON-SCREEN gate: a session the user is currently looking at never shows review
 *   (`isOnScreen`) — "if I can see it, I don't need a cue". This is evaluated HERE, at
 *   display time and continuously, NOT latched when the turn ended: on the GPU-less
 *   VDI/SwiftShader host the focus signal is briefly unreliable at the finish instant
 *   (§9.7), so the raise is unconditional and the on-screen decision is deferred to
 *   the settled present-time value read on each render.
 */
export function sessionDisplayState(
  session: SessionDTO,
  hasUnseenFinishedTurn: boolean,
  isOnScreen: boolean
): DisplayState {
  switch (sessionAggregationState(session)) {
    case 'blocked':
      return 'needsInput'
    case 'working':
      return 'working'
    case 'waiting':
      return hasUnseenFinishedTurn && !isOnScreen ? 'review' : 'idle'
    default:
      return 'none'
  }
}

/**
 * A task's rollup icon: the MAX display priority across ALL its sessions, in any
 * window (§3.4/§9.5). This replaces the old "(worst-wins state) + (separate ORed
 * ready-for-review flag)" pair, which could not express review-on-one-session-while-
 * another-works and let a stale flag suppress a session's real `working`. Computing
 * the rollup from per-session display levels (each already gated by `sessionDisplayState`)
 * makes both correct: `needsInput` > `review` > `working` > `idle`.
 */
export function taskDisplayState(data: StoreData, taskId: string): DisplayState {
  const task = data.tasks[taskId]
  if (!task) return 'none'
  let best: DisplayState = 'none'
  for (const id of task.sessionIds) {
    const session = data.sessions[id]
    if (!session) continue
    const d = sessionDisplayState(
      session,
      data.hasUnseenFinishedTurn[id] === true,
      isSessionFocused(data, id)
    )
    if (DISPLAY_RANK[d] > DISPLAY_RANK[best]) best = d
  }
  return best
}

/**
 * Worst-status-wins rank over the wire state strings, mirroring the domain
 * `STATE_RANK` lattice (§3.4): `blocked > working > waiting > unknown`. The renderer
 * may not import `domain`, so the lattice is duplicated here in wire values (the
 * enum VALUES the domain uses). Higher wins the reduction.
 */
const AGG_RANK: Readonly<Record<string, number>> = {
  unknown: 0,
  waiting: 1,
  working: 2,
  blocked: 3
}

/**
 * The state a session contributes to its task's worst-wins rollup (I12). A session
 * that has exited or failed to start counts as `blocked` — it needs the user's
 * attention (restart/dismiss) exactly like a permission prompt — regardless of the
 * last detection state it carried. Mirrors the domain `lifecycleToAggregationState`.
 */
function sessionAggregationState(session: SessionDTO): string {
  if (session.lifecycle === 'exited' || session.lifecycle === 'start_failed') return 'blocked'
  return session.state
}

/**
 * Recompute a task's derived `state` from its sessions' worst-wins aggregate (§3.4,
 * I11). Called from the `sessionStateChanged` reducer so a session flip updates the
 * task rollup in the SAME transition — the backend also emits a `taskStateChanged`,
 * but relying on that separate message left the two momentarily desynced (bug 2.1:
 * a session showing `needs input` while its task still showed `idle`).
 */
function recomputeTaskState(data: StoreData, taskId: string): StoreData {
  const task = data.tasks[taskId]
  if (!task) return data
  let worst = 'unknown'
  for (const id of task.sessionIds) {
    const session = data.sessions[id]
    if (!session) continue
    const s = sessionAggregationState(session)
    if ((AGG_RANK[s] ?? 0) > (AGG_RANK[worst] ?? 0)) worst = s
  }
  if (worst === task.state) return data
  return patchTask(data, taskId, { state: worst })
}

/** Immutably patch one task entry; no-op if the task is unknown. */
function patchTask(data: StoreData, taskId: string, patch: Partial<TaskEntry>): StoreData {
  const existing = data.tasks[taskId]
  if (!existing) return data
  return { ...data, tasks: { ...data.tasks, [taskId]: { ...existing, ...patch } } }
}

/** Copy a record, dropping one key. Avoids a bound-but-unused destructure. */
function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const k of Object.keys(record)) {
    if (k !== key) next[k] = record[k]
  }
  return next
}

/** Drop a session from the flat map, its task's `sessionIds`, and fix the active tab. */
function removeSession(data: StoreData, taskId: string, sessionId: string): StoreData {
  const sessions = omit(data.sessions, sessionId)
  const task = data.tasks[taskId]
  // Drop any lingering ready-for-review flag for the gone session (§9.5).
  let next: StoreData = {
    ...data,
    sessions,
    hasUnseenFinishedTurn: clearReady(data.hasUnseenFinishedTurn, sessionId)
  }
  if (task) {
    const sessionIds = task.sessionIds.filter((id) => id !== sessionId)
    next = patchTask(next, taskId, { sessionIds })
    // Closing this window's marked tab re-marks a neighbour (§3.7). Prefer the closed
    // session's groupmate (next, else previous, in the group's own tab order) over the
    // window's last tab: `sessionClosed` arrives BEFORE `groupsChanged` (dissolving the
    // group at 1 member, DESIGN §5.7, is reconciled separately), so `data.groupsByTask`
    // — read from the OLD `data`, not `next` — still has the closed session as a leaf.
    // Falls back to the window's last tab for a lone session, or one whose last
    // groupmate is also gone.
    if (next.activeSessionByTask[taskId] === sessionId) {
      const ids = sessionIdsInWindow(next, taskId, data.windowId)
      const group = groupOfSession(data, taskId, sessionId)
      const neighbour = group ? neighbourInGroup(task.sessionIds, group, sessionId, ids) : undefined
      next = withMark(next, taskId, neighbour ?? ids[ids.length - 1])
    }
    // The removed session no longer contributes to the task rollup — recompute its
    // worst-wins state so a closed `Working`/`NeedsInput` session stops pinning the
    // task icon to a stale rank (§3.4).
    next = recomputeTaskState(next, taskId)
  }
  return next
}

/**
 * The adjacent member to `sessionId` within `group`'s TAB order (next, else previous)
 * that is still in `hosted` (IMP3 fix): closing a grouped tab prefers a groupmate over
 * jumping to the window's last tab. `fullOrder` is the task's session order from BEFORE
 * the removal (closing is reconciled before `groupsChanged`, so `group` still lists
 * `sessionId` as a leaf) — tab order, not the group's tree a/b order.
 */
function neighbourInGroup(
  fullOrder: readonly string[],
  group: GroupDTO,
  sessionId: string,
  hosted: readonly string[]
): string | undefined {
  const members = new Set(leafIds(group.layout))
  const tabOrdered = fullOrder.filter((id) => members.has(id))
  const i = tabOrdered.indexOf(sessionId)
  const next = tabOrdered[i + 1]
  if (next !== undefined && hosted.includes(next)) return next
  const prev = tabOrdered[i - 1]
  if (prev !== undefined && hosted.includes(prev)) return prev
  return undefined
}

/**
 * Gate for the §9.5 status-change toast: returns `true` (and arms a cooldown) when the
 * toast should be shown, `false` while the session is throttled. Passed into
 * {@link reduceEvent} by `applyEvent`; defaults to always-admit so direct-reducer tests
 * (and any non-throttled caller) behave as before. See {@link createNotificationThrottle}.
 */
export type NotificationAdmit = (sessionId: string) => boolean

const ADMIT_ALL: NotificationAdmit = () => true

/**
 * Guard a drawer action against unsaved edits ("Issues"). While
 * {@link StoreData.issueEditDirty}, defer `pending` to {@link StoreData.discardPrompt}
 * instead of running `perform`; otherwise run `perform` directly. Shared by every
 * dirty-guarded drawer transition (close, select, new) so the discard-prompt policy
 * lives in one place.
 */
function withDiscardGuard(
  data: StoreData,
  pending: DiscardPendingAction,
  perform: (data: StoreData) => StoreData
): StoreData {
  if (data.issueEditDirty) {
    return { ...data, discardPrompt: pending }
  }
  return perform(data)
}

/**
 * Bump {@link StoreData.issueEditSession}. Called on every drawer
 * transition that actually lands on a (possibly new) edit target: a resolved
 * select, a fresh draft start, or a discard. Unconditional even when the
 * resulting `selectedIssueId`/`issueDraft` pair comes out equal to what it
 * already was (re-picking the shown issue, or discarding a draft back into a
 * fresh draft) — `IssueDetail` keys its reset effect on this counter precisely
 * so those cases still clear stale local state.
 */
function bumpSession(data: StoreData): StoreData {
  return { ...data, issueEditSession: data.issueEditSession + 1 }
}

/**
 * Toggle the drawer open/closed ("Issues"). Opening is unconditional. Closing is
 * dirty-guarded via {@link withDiscardGuard} and clears {@link StoreData.issueDraft}, and
 * bumps {@link StoreData.issueEditSession}: without it, a close that leaves
 * `selectedIssueId` unchanged (nothing else resets it) would let a later reopen onto a
 * DIFFERENT issue skip `IssueDetail`'s session-keyed reset — e.g. closing out of an edit,
 * then opening straight onto another issue, would show that issue under the previous
 * one's stale edit form. Pure, so both the `toggleIssuesDrawer` action and the
 * `issuesDrawerToggle` wire event (the secondary-window shortcut relay) go through
 * identical logic.
 */
function toggleDrawerData(data: StoreData): StoreData {
  if (!data.issuesDrawerOpen) {
    return { ...data, issuesDrawerOpen: true }
  }
  return withDiscardGuard(data, { kind: 'close' }, (d) =>
    bumpSession({
      ...d,
      issuesDrawerOpen: false,
      issueDraft: false
    })
  )
}

/**
 * Perform (not guard) a selection: point the drawer at `issueId` and clear draft/dirty
 * state. Bumps {@link StoreData.issueEditSession} unconditionally — even a
 * reselect of the already-shown issue (filtered out by the callers below before this
 * runs) would otherwise leave `IssueDetail` keyed on an unchanged `selectedIssueId`.
 */
function performSelect(data: StoreData, issueId: string): StoreData {
  return bumpSession({
    ...data,
    selectedIssueId: issueId,
    issueDraft: false,
    issueEditDirty: false,
    discardPrompt: null
  })
}

/**
 * Open the drawer onto `issueId` (or just open it, keeping the current selection, if
 * omitted). If already open with a given `issueId`, this is a dirty-guarded select —
 * and a no-op if `issueId` is already the clean selection shown (reselecting
 * the issue already open must not re-run the reset effect). Opening a CLOSED drawer is
 * unconditional (no dirty state can exist while closed) but still bumps
 * {@link StoreData.issueEditSession}: the drawer being closed does not, by
 * itself, guarantee `IssueDetail`'s own local edit UI (editing mode, busy/error flags,
 * nested dialog steps) was ever reset — closing is now session-bumped too (see
 * `toggleDrawerData`), but defending here as well covers any OTHER path that can close
 * the drawer without going through that helper. Without this bump, reopening straight
 * onto a bound task's issue (e.g. its row icon in the Progress panel) while a previous
 * issue's edit form is still showing underneath lands on the new issue in the stale
 * edit mode, with the previous issue's fields — Save would then write them onto the
 * wrong issue.
 */
function openDrawerData(data: StoreData, issueId: string | undefined): StoreData {
  if (!data.issuesDrawerOpen) {
    return bumpSession({
      ...data,
      issuesDrawerOpen: true,
      selectedIssueId: issueId ?? data.selectedIssueId
    })
  }
  if (issueId === undefined) return data
  if (!data.issueDraft && data.selectedIssueId === issueId) return data
  return withDiscardGuard(data, { kind: 'select', issueId }, (d) => performSelect(d, issueId))
}

/**
 * Select a different issue in the drawer. Dirty-guarded via {@link withDiscardGuard};
 * a no-op if `issueId` is already the clean selection shown.
 */
function selectIssueData(data: StoreData, issueId: string): StoreData {
  if (!data.issueDraft && data.selectedIssueId === issueId) return data
  return withDiscardGuard(data, { kind: 'select', issueId }, (d) => performSelect(d, issueId))
}

/** Start a "+ New Issue" draft. Dirty-guarded via {@link withDiscardGuard}. */
function startNewIssueData(data: StoreData): StoreData {
  return withDiscardGuard(data, { kind: 'new' }, (d) =>
    bumpSession({
      ...d,
      selectedIssueId: undefined,
      issueDraft: true,
      issueEditDirty: false,
      discardPrompt: null
    })
  )
}

/**
 * Perform the pending `discardPrompt` action (discarding the dirty edit) and clear it.
 * Bumps {@link StoreData.issueEditSession} unconditionally: e.g. discarding a
 * fresh draft back into another fresh draft (`kind: 'new'`) leaves `issueDraft`/
 * `selectedIssueId` unchanged, so without the bump `IssueDetail`'s reset effect
 * wouldn't fire and stale draft text would stay on screen.
 */
function confirmDiscardData(data: StoreData): StoreData {
  const pending = data.discardPrompt
  if (!pending) return data
  const cleared: StoreData = bumpSession({
    ...data,
    issueEditDirty: false,
    issueDraft: false,
    discardPrompt: null
  })
  switch (pending.kind) {
    case 'close':
      return { ...cleared, issuesDrawerOpen: false }
    case 'select':
      return { ...cleared, selectedIssueId: pending.issueId }
    case 'new':
      return { ...cleared, selectedIssueId: undefined, issueDraft: true }
    default: {
      const _never: never = pending
      return _never
    }
  }
}

/**
 * The pure event reducer. Returns the next `StoreData` for every wire event.
 * `ptyData` is ignored here (it bypasses the store, §5.2); the dormant
 * state-changed events (§10) patch the `state` field but nobody emits them in V1.
 *
 * `admit` gates ONLY the §9.5 notification toast and is consulted AFTER focus suppression,
 * so a toast the user would never see never consumes the throttle window (that anchoring
 * is the whole reason the throttle lives renderer-side — see notification-throttle.ts).
 * It defaults to always-admit; `applyEvent` supplies the real per-window throttle.
 */
export function reduceEvent(
  data: StoreData,
  event: EventDTO,
  admit: NotificationAdmit = ADMIT_ALL
): StoreData {
  switch (event.type) {
    case 'ptyData':
      return data // bypasses the store entirely (§5.2)

    case 'taskCreated': {
      // Upsert: create-task emits this twice (Provisioning then Ready).
      const { entry, sessions: ss } = normalizeTask(event.task)
      const isNew = !data.tasks[entry.id]
      const sessions = { ...data.sessions }
      for (const s of ss) sessions[s.id] = s
      // Derive this window's mark for a task that arrives carrying sessions
      // (reconciled/hydrated tasks): keep a still-hosted mark, else the persisted
      // last-focused session if hosted here, else this window's first tab (§3.7). A
      // fresh task has none, so nothing to set.
      const hosted = ss.filter((s) => s.windowId === data.windowId).map((s) => s.id)
      const mark = pickMark(hosted, data.activeSessionByTask[entry.id], entry.activeSessionId)
      return withMark(
        {
          ...data,
          tasks: { ...data.tasks, [entry.id]: entry },
          sessions,
          groupsByTask: { ...data.groupsByTask, [entry.id]: event.task.groups },
          taskOrder: isNew ? [...data.taskOrder, entry.id] : data.taskOrder
        },
        entry.id,
        mark
      )
    }

    case 'taskDeleted': {
      const tasks = omit(data.tasks, event.taskId)
      const activeSessionByTask = omit(data.activeSessionByTask, event.taskId)
      // Drop this window's groups for the doomed task (DESIGN §5.7, split-groups design) —
      // the backend's rows are cascaded away, nothing to reconcile against.
      const groupsByTask = omit(data.groupsByTask, event.taskId)
      const doomed = data.tasks[event.taskId]?.sessionIds ?? []
      const sessions = { ...data.sessions }
      for (const id of doomed) delete sessions[id]
      return {
        ...data,
        tasks,
        sessions,
        activeSessionByTask,
        groupsByTask,
        taskOrder: data.taskOrder.filter((id) => id !== event.taskId),
        activeTaskId: data.activeTaskId === event.taskId ? undefined : data.activeTaskId
      }
    }

    case 'taskRenamed':
      return patchTask(data, event.taskId, { name: event.name })

    case 'taskStale':
      return patchTask(data, event.taskId, { lifecycle: 'stale' })

    case 'taskReordered': {
      const known = event.orderedTaskIds.filter((id) => data.tasks[id])
      return { ...data, taskOrder: known }
    }

    case 'activeTaskChanged':
      // A view window is pinned to its task (window-view feature) and ignores this —
      // defensively: main's `WindowRegistry` already never sends `activeTaskChanged`
      // to a view window, so this never actually fires there in practice.
      if (data.viewTaskId !== undefined) return data
      // A newer local pick is in flight: this is an echo of an earlier switch (see
      // `inFlightTaskSwitches`) and would flicker the window back through it.
      if (data.inFlightTaskSwitches > 0) return data
      // Pure visibility (I9). NO ready-for-review clear here (§9.5): a task switch makes
      // each window show ITS OWN mark for the task, and only the focused window's mark is
      // actually looked at — which window that is, only that window knows. Its
      // `markVisibleSessionSeen` effect (App) clears that one session on the settled
      // render and relays `sessions.markSeen` → `sessionSeen` to every window, so the
      // main-window rollup converges without wrongly marking a blurred window's tab seen.
      return { ...data, activeTaskId: event.taskId }

    case 'activeSessionChanged': {
      // Broadcast to every window so cross-window session switching works (§5.4):
      // a task's sessions can live in different windows, so the cycle can land on a
      // session hosted elsewhere. Only the window that HOSTS the session
      // (`event.windowId === thisWindowId`) moves its mark and makes the task active, so
      // its `TaskView` is the one on screen when the OS raises it (the raise itself is
      // done in main). Every OTHER window keeps its own mark (§3.7): the window the user
      // just left keeps showing — and marking — the session it had.
      //
      // The ready-for-review CLEAR is GLOBAL, not host-only (§9.5): switching to a
      // session focuses and raises its host window (composition-root), so the user has
      // now looked at it. The flag must clear in EVERY window's store — the task rollup
      // (`taskDisplayState`) is shown only in the main window yet folds over sessions
      // hosted in ANY window, so a host-only clear left the main window's task dot lit
      // after the user focused a session living in another window.
      const cleared = clearReady(data.hasUnseenFinishedTurn, event.sessionId)
      if (event.windowId !== data.windowId) {
        return cleared === data.hasUnseenFinishedTurn
          ? data
          : { ...data, hasUnseenFinishedTurn: cleared }
      }
      let next: StoreData = { ...data, activeTaskId: event.taskId, hasUnseenFinishedTurn: cleared }
      if (data.sessions[event.sessionId]?.windowId === data.windowId) {
        next = withMark(next, event.taskId, event.sessionId)
      }
      // A switch from ANOTHER window lands here while we are still blurred: flash now
      // (§5.4) rather than rely on the raise's focus event, which may arrive first (and
      // flash the old mark — the flash follows the mark, so it moves here) or late.
      // `setWindowFocused` dedupes against a flash already on.
      return data.windowFocused ? next : armFlash(next)
    }

    case 'sessionCreated': {
      const s = event.session
      const task = data.tasks[event.taskId]
      const next: StoreData = { ...data, sessions: { ...data.sessions, [s.id]: s } }
      if (!task) return next
      const sessionIds = task.sessionIds.includes(s.id)
        ? task.sessionIds
        : [...task.sessionIds, s.id]
      const added = patchTask(next, event.taskId, { sessionIds })
      // Every window learns of the session; only the window hosting it marks it (§3.7). A
      // split-chord creation (`CreateSessionInput.split`, DESIGN §5.7) joins it into the
      // anchor's group on the backend in the SAME command; that result arrives separately
      // as `groupsChanged`, so there is nothing group-shaped to do here.
      return s.windowId === data.windowId ? withMark(added, event.taskId, s.id) : added
    }

    case 'groupsChanged':
      // Consistent with the other per-task reducers (e.g. `taskRenamed`): a task this
      // window doesn't know about yet (or ever) can't own a group list.
      if (!data.tasks[event.taskId]) return data
      return { ...data, groupsByTask: { ...data.groupsByTask, [event.taskId]: event.groups } }

    case 'sessionExited': {
      // The session stays as a tab (§6.1) but is now dead; only lifecycle changes.
      // `exitCode` has no field in SessionDTO — it's for toasts/UI, not the model.
      const s = data.sessions[event.sessionId]
      if (!s) return data
      const updated: SessionDTO = { ...s, lifecycle: 'exited' }
      // An exited session aggregates as `NeedsInput` (I12, `sessionAggregationState`) —
      // recompute the task rollup so the icon reflects the exit immediately rather than
      // waiting for a later `sessionStateChanged` (§3.4).
      const next = recomputeTaskState(
        {
          ...data,
          sessions: { ...data.sessions, [event.sessionId]: updated }
        },
        s.taskId
      )
      // Surface an unexpected exit as a toast (§5.4): a non-zero (or missing) exit
      // code is a failure worth flagging; a clean `exit 0` is silent.
      const clean = event.exitCode === 0
      return clean
        ? next
        : pushToastData(
            next,
            'error',
            event.exitCode == null
              ? `${s.title} exited unexpectedly`
              : `${s.title} exited (code ${event.exitCode})`
          )
    }

    case 'sessionClosed':
      return removeSession(data, event.taskId, event.sessionId)

    case 'sessionRenamed': {
      const s = data.sessions[event.sessionId]
      if (!s) return data
      return {
        ...data,
        sessions: { ...data.sessions, [event.sessionId]: { ...s, title: event.title } }
      }
    }

    case 'sessionReordered': {
      const task = data.tasks[event.taskId]
      if (!task) return data
      const known = event.orderedSessionIds.filter((id) => data.sessions[id])
      return patchTask(data, event.taskId, { sessionIds: known })
    }

    case 'scriptError': {
      const message = event.stderr.trim() || `${event.script} failed (exit ${event.exitCode})`
      return pushToastData(data, 'error', message)
    }

    case 'error':
      return pushToastData(data, 'error', event.message)

    case 'scriptProgress':
      return data // surfaced by the New-Task modal, not the global store

    case 'sessionStateChanged': {
      // Patch the session's state field (§9). Also raise the "finished, unseen"
      // memory (§9.5): a `working → waiting` transition means "just finished". It is
      // raised UNCONDITIONALLY (the on-screen check is deferred to display time, see
      // the raise site below). `blocked → waiting` (an answered prompt) and a
      // straight-to-waiting (fresh prompt, no prior `working`) do NOT raise it.
      const s = data.sessions[event.sessionId]
      if (!s) return data
      const prev = s.state
      // Append to the debug-overlay ring (§11), evicting the oldest past capacity.
      const transition: DebugTransition = {
        seq: data.nextDebugSeq,
        sessionId: event.sessionId,
        from: prev,
        to: event.state,
        layer: event.layer,
        confidence: event.confidence,
        reason: event.reason
      }
      const ring = [...data.debugTransitions, transition].slice(-DEBUG_RING_CAPACITY)
      const withSession: StoreData = {
        ...data,
        sessions: { ...data.sessions, [event.sessionId]: { ...s, state: event.state } },
        debugTransitions: ring,
        nextDebugSeq: data.nextDebugSeq + 1
      }
      // Roll the change up into the task's derived state in the same transition
      // (§3.4, bug 2.1) — don't wait for the separate taskStateChanged message.
      const next = recomputeTaskState(withSession, s.taskId)
      // Raise the "finished, unseen" memory UNCONDITIONALLY on Working → Waiting
      // (§9.5). It is a durable marker that a turn finished here; whether to SHOW the
      // review dot is decided later in `sessionDisplayState` against the settled
      // present-time on-screen value. We deliberately do NOT consult focus at this
      // instant: on the VDI/SwiftShader host the focus signal churns at turn-end
      // (§9.7), so gating the raise here produced a stuck dot for a session the user
      // was actually watching. The `working → waiting` guard already excludes a fresh
      // session that goes straight to `waiting` (no prior Working) and a
      // `blocked → waiting` resolution — neither "just finished" work.
      const justFinished = prev === 'working' && event.state === 'waiting'
      if (justFinished) {
        return {
          ...next,
          hasUnseenFinishedTurn: { ...next.hasUnseenFinishedTurn, [event.sessionId]: true }
        }
      }
      // Defense-in-depth (§9.5): leaving `waiting` (e.g. waiting → working when the
      // agent resumes) invalidates any stale finished-unseen flag — the session is
      // no longer "just finished, awaiting eyes". Consumption-time gating in
      // `sessionDisplayState` already ignores the flag off-idle, but clearing it here
      // keeps the store honest so no consumer (or the debug read-out) is misled.
      if (event.state !== 'waiting' && next.hasUnseenFinishedTurn[event.sessionId]) {
        return {
          ...next,
          hasUnseenFinishedTurn: clearReady(next.hasUnseenFinishedTurn, event.sessionId)
        }
      }
      return next
    }

    case 'taskStateChanged':
      // Dormant seam (§10): patch the task's derived state. Unused in V1.
      return patchTask(data, event.taskId, { state: event.state })

    case 'sessionStateNotification':
      // In-app status-change notification (§9.5): render as an info toast with a bold
      // "State changed" title over a `<Task> - <Session>` body. The notification
      // deliberately carries NO old/new state — the user glances at it and checks the
      // session themselves; it no longer depends on Claude's hook timing for a from→to.
      //
      // SUPPRESS when the user is already looking at the session that changed: if I
      // can see Claude myself, I don't need a toast about it. `isSessionFocused` is
      // the authoritative per-window "on screen right now" check (live DOM focus +
      // active task/tab + this-window host) — the SAME predicate ready-for-review
      // uses. Deciding this in the renderer (not main) makes it symmetric across
      // both transition directions: main's focus snapshot at ingestion is racy for
      // `working → waiting` (repaint + post-Stop hook), which is why "finished"
      // toasts previously leaked through while "started" ones were suppressed.
      if (isSessionFocused(data, event.sessionId)) {
        return data
      }
      // Leading-edge throttle, consulted ONLY once we know the toast would be shown, so a
      // focus-suppressed change never arms the window (§9.5). `admit` is false while the
      // session is still within the cooldown of the last SHOWN toast — drop without a
      // toast; the tab/task icons already reflect every state via `sessionStateChanged`.
      if (!admit(event.sessionId)) {
        return data
      }
      return pushToastData(
        data,
        'info',
        `${event.taskName} - ${event.sessionName}`,
        'State changed'
      )

    case 'sessionSeen': {
      // Cross-window ready-for-review clear (§9.5): another window watched this session
      // finish in place and reported it seen. Clear the "unseen finished turn" flag here
      // too so THIS window's task rollup (which folds over sessions in ANY window but
      // knows only its own focus) stops showing `review`. Idempotent: in the window that
      // already cleared it locally (`markVisibleSessionSeen`) the map is unchanged, so we
      // return `data` by identity — no spurious re-render.
      const cleared = clearReady(data.hasUnseenFinishedTurn, event.sessionId)
      if (cleared === data.hasUnseenFinishedTurn) return data
      return { ...data, hasUnseenFinishedTurn: cleared }
    }

    case 'sessionMovedToWindow': {
      // A pure view re-assignment (§6.7, I18): only `windowId` changes — never
      // `taskId` or lifecycle. Each window renders sessions where
      // `windowId === thisWindowId`, so patching the flat record makes the source
      // window's filter drop the pane and the target window's filter mount it. The
      // session may be unknown to a window that never held it (harmless no-op).
      //
      // A whole-group move (DESIGN §5.7 "every group member shares one window") sends
      // ONE event per member — the directly-sent one first, the rest tagged `cause:
      // 'groupMove'` — but the backend moves the whole group atomically, so this window
      // must too (IMP1 fix): on the FIRST event to land for the group, reassign EVERY
      // member's `windowId` here, in this single reducer step, rather than waiting for
      // each member's own later event. Without this, a groupmate whose own event hasn't
      // arrived yet would still read its OLD `windowId` — making `sessionIdsInWindow`
      // (hence `activeSessionInWindow`'s `ids[0]` fallback) treat it as still hosted
      // and briefly "on screen" here, wrongly clearing its review dot
      // (`markVisibleSessionSeen`) and getting persisted as focused
      // (`usePersistFocusedSession`), both wrong per CLAUDE_STATE_PRD. Every LATER event
      // for another member of the same move is then an idempotent no-op: by the time it
      // arrives its own session already carries `windowId === toWindowId` (moved on the
      // first event), caught by the guard below — so it re-marks nothing in either
      // window and leaves whatever the first event already decided.
      //
      // Marks (§3.7): the TARGET window marks the DIRECTLY-sent session — the user put
      // it there to look at it — unless the move is a disposition that must not replace
      // what the target was showing (it keeps the target's existing mark instead): the
      // "move sessions to main" disposition of closing a window (`cause:
      // 'windowClosed'`), or this being an EXTRA group member riding along with the
      // directly-moved one (`cause: 'groupMove'` — only the directly-sent member, no
      // `cause`, is ever marked in the target). The SOURCE window, if the moved group's
      // mark was one of the moving members, re-marks the nearest tab OUTSIDE the whole
      // moving set.
      const s = data.sessions[event.sessionId]
      if (!s) return data
      // Idempotent no-op: this member already moved (as part of the group it belongs
      // to, on an earlier event in this same move) — nothing left to do in either
      // window.
      if (s.windowId === event.toWindowId) return data

      const before = sessionIdsInWindow(data, s.taskId, data.windowId)
      // The WHOLE moving set: the moved session's group's leaves, restricted to members
      // CURRENTLY hosted in the session's own (FROM) window — defensive; the "members
      // share a window" invariant guarantees they all are — or just the session itself
      // if it's lone.
      const group = groupOfSession(data, s.taskId, s.id)
      const movingSet = group
        ? new Set(leafIds(group.layout).filter((id) => data.sessions[id]?.windowId === s.windowId))
        : new Set([s.id])

      let sessions = data.sessions
      for (const id of movingSet) {
        const member = sessions[id]
        if (member) sessions = { ...sessions, [id]: { ...member, windowId: event.toWindowId } }
      }
      const next: StoreData = { ...data, sessions }

      if (event.toWindowId === data.windowId) {
        const keep =
          event.cause === 'windowClosed' || event.cause === 'groupMove'
            ? next.activeSessionByTask[s.taskId]
            : undefined
        return withMark(next, s.taskId, keep ?? s.id)
      }

      // Moving OUT of this window: re-mark only if the CURRENT mark is somewhere in the
      // whole moving set, to the nearest tab OUTSIDE it.
      const mark = data.activeSessionByTask[s.taskId]
      if (mark !== undefined && movingSet.has(mark)) {
        const i = before.indexOf(s.id)
        return withMark(next, s.taskId, nearestOutside(before, i, movingSet))
      }
      return next
    }

    case 'windowCreated': {
      // Track the new window (§6.7). Upsert-safe: ignore a duplicate id. Carries
      // `taskId`/`parentWindowId` (window-view feature) so `viewWindowForTask`/
      // `windowGroupRoot` resolve correctly for a freshly-created view or its
      // secondaries without waiting for a re-hydrate.
      if (data.windows.some((w) => w.id === event.windowId)) return data
      const win: WindowDTO = {
        id: event.windowId,
        role: event.role,
        bounds: event.bounds,
        createdAt: 0,
        taskId: event.taskId,
        parentWindowId: event.parentWindowId
      }
      return { ...data, windows: [...data.windows, win] }
    }

    case 'windowClosed':
      return { ...data, windows: data.windows.filter((w) => w.id !== event.windowId) }

    case 'viewCreated':
    case 'viewClosed':
      // Informational markers (window-view feature): the window list is already kept
      // correct by `windowCreated`/`windowClosed` (which the backend always emits
      // around these, in either order relative to them) and session reassignment rides
      // its own `sessionMovedToWindow` events — nothing left for these two to patch, so
      // they're intentional no-ops. They exist as reducer cases purely so the
      // exhaustive `EventDTO` switch below stays total.
      return data

    case 'issueUpserted':
      return { ...data, issues: { ...data.issues, [event.issue.id]: event.issue } }

    case 'issueDeleted': {
      const issues = omit(data.issues, event.issueId)
      // A pending discard prompt to SELECT this issue no longer makes sense once
      // it's gone — clear it regardless of what's currently selected, so
      // confirming it later can't try to select an issue that no longer exists.
      const discardPrompt =
        data.discardPrompt?.kind === 'select' && data.discardPrompt.issueId === event.issueId
          ? null
          : data.discardPrompt
      if (data.selectedIssueId !== event.issueId) {
        return { ...data, issues, discardPrompt }
      }
      // The deleted issue was showing in the drawer: drop the selection and any
      // draft/dirty/discard state tied to it rather than leave the right pane
      // pointing at an issue that no longer exists. Bumps `issueEditSession`
      // so `IssueDetail`'s local edit UI (editing mode, busy/error flags, nested
      // dialog steps) resets too, not just the store's own selection fields.
      return bumpSession({
        ...data,
        issues,
        selectedIssueId: undefined,
        issueDraft: false,
        issueEditDirty: false,
        discardPrompt: null
      })
    }

    case 'issuesDrawerToggle':
      // Secondary-window shortcut relay ("Issues"): routed only to the main window,
      // which runs the SAME dirty-guarded toggle as the local `toggleIssuesDrawer` action.
      return toggleDrawerData(data)

    default: {
      // Exhaustiveness guard: a new EventDTO member must be handled above.
      const _never: never = event
      return _never
    }
  }
}

function pushToastData(
  data: StoreData,
  kind: ToastKind,
  message: string,
  title?: string
): StoreData {
  const toast: Toast = { id: data.nextToastId, kind, title, message }
  return { ...data, toasts: [...data.toasts, toast], nextToastId: data.nextToastId + 1 }
}

/**
 * This window's leading-edge notification throttle (§9.5). Module-scoped (one store per
 * window) so its cooldown is per-window and survives across `applyEvent` calls — a pure
 * reducer can't hold a timer. It is consulted only for toasts that pass focus suppression,
 * so the window is anchored to the toast the user actually saw. Never disposed: it lives
 * for the window's lifetime and holds at most one short-lived timer per active session.
 */
const notificationThrottle = createNotificationThrottle()

export const useStore = create<Store>((set, get) => ({
  ...initialData(),

  // Re-hydrate (SettingsModal) keeps this window's marks and its live OS-focus value:
  // `useWindowFocus` seeds `windowFocused` from `document.hasFocus()` on mount, before the
  // async `getState` lands, so resetting it to the default `true` would make every
  // window look focused (and push its mark as the focused session, §5.4).
  hydrate: (state) =>
    set((data) => {
      const hydrated = hydrateData(state, data.activeSessionByTask)
      // The selection can go stale across a re-hydration: e.g. another
      // window deleted the selected issue while this window's `SettingsModal`
      // round-trip was in flight. Drop it rather than leave the drawer pointing at
      // an issue `hydrated.issues` no longer has.
      const selectedIssueId =
        data.selectedIssueId !== undefined && hydrated.issues[data.selectedIssueId]
          ? data.selectedIssueId
          : undefined
      const droppedSelection = data.selectedIssueId !== undefined && selectedIssueId === undefined
      // A pending discard prompt to SELECT an issue that's also gone no longer makes
      // sense either (mirroring `issueDeleted`'s own clearing of it) — clear
      // it so confirming it later can't try to select an issue that no longer exists.
      const discardPrompt =
        data.discardPrompt?.kind === 'select' && !hydrated.issues[data.discardPrompt.issueId]
          ? null
          : data.discardPrompt
      return {
        ...hydrated,
        windowFocused: data.windowFocused,
        windowFocusedOnce: data.windowFocusedOnce,
        focusFlashSeq: data.focusFlashSeq,
        // Drawer view-state is renderer-local and never carried on the wire (DTO has
        // no such field): a re-hydration (e.g. after SettingsModal save) must not
        // reset it, the same way the window-focus fields above survive.
        issuesDrawerOpen: data.issuesDrawerOpen,
        issuesDrawerTab: data.issuesDrawerTab,
        // Settings modal open-state is likewise renderer-local view-state (never carried
        // on the wire) — a re-hydration triggered BY the SettingsModal's own save must not
        // close the modal that's still showing its own success/pending UI.
        settingsOpen: data.settingsOpen,
        // Renderer-local too: the in-flight replies still arrive after a re-hydration.
        inFlightTaskSwitches: data.inFlightTaskSwitches,
        selectedIssueId,
        issueDraft: data.issueDraft,
        // Dropping a stale selection discards any dirty edit tied to it too,
        // and bumps `issueEditSession` so `IssueDetail`'s local edit UI
        // resets along with it rather than keep showing the vanished issue's fields.
        issueEditDirty: droppedSelection ? false : data.issueEditDirty,
        discardPrompt,
        issueEditSession: droppedSelection ? data.issueEditSession + 1 : data.issueEditSession
      }
    }),

  applyEvent: (event) => set((data) => reduceEvent(data, event, notificationThrottle.admit)),

  // Immediate same-window feedback before the tasks.switch round-trip lands the broadcast
  // activeTaskChanged. No ready-for-review clear here (§9.5): the on-screen session is
  // cleared — and relayed to every window — by `markVisibleSessionSeen` on the settled
  // render; clearing it locally first would swallow that cross-window relay.
  //
  // A view window is pinned to its task (window-view feature) — no-op there, so no local
  // "switch task" path (keyboard task-cycle, a stray call) can move it off `viewTaskId`.
  //
  // Every call MUST be paired with a `tasks.switch` whose settlement calls
  // `taskSwitchSettled` (see `inFlightTaskSwitches`).
  setActiveTask: (taskId) =>
    set((data) =>
      data.viewTaskId !== undefined
        ? data
        : { activeTaskId: taskId, inFlightTaskSwitches: data.inFlightTaskSwitches + 1 }
    ),

  taskSwitchSettled: () =>
    set((data) => ({ inFlightTaskSwitches: Math.max(0, data.inFlightTaskSwitches - 1) })),

  setActiveSession: (taskId, sessionId) =>
    set((data) => {
      // Focusing a session clears its ready-for-review flag (§9.5); the paired
      // `sessions.switch` broadcast clears it in every other window.
      const hasUnseenFinishedTurn = clearReady(data.hasUnseenFinishedTurn, sessionId)
      // Only a session hosted here can be this window's mark (§3.7).
      if (data.sessions[sessionId]?.windowId !== data.windowId) return { hasUnseenFinishedTurn }
      return { ...withMark(data, taskId, sessionId), hasUnseenFinishedTurn }
    }),

  setGroupTasksByRepo: (value) =>
    set((data) => ({ settings: { ...data.settings, groupTasksByRepo: value } })),

  setJiraLastFilters: (filters) =>
    set((data) => ({
      settings: { ...data.settings, jira: { ...data.settings.jira, lastFilters: filters } }
    })),

  pushToast: (kind, message) => set((data) => pushToastData(data, kind, message)),

  dismissToast: (id) => set((data) => ({ toasts: data.toasts.filter((t) => t.id !== id) })),

  setWindowFocused: (focused) =>
    set((data) => {
      // Blur ends any focus flash (§5.4).
      if (!focused) {
        return data.windowFocused ? { ...data, windowFocused: false, focusFlashOn: false } : data
      }
      if (data.windowFocused && data.windowFocusedOnce) return data
      const next = { ...data, windowFocused: true, windowFocusedOnce: true }
      // The window's first-ever focus (it just appeared, or the mount-time seed of an
      // already-focused window) doesn't flash. Moving back INTO it flashes the marked tab
      // (§5.4) — unless a flash is already on (armed by an `activeSessionChanged` that beat
      // this focus event), so it doesn't restart. Regaining focus also counts as "looking
      // at" the visible session (§9.5), but that clear is left to `markVisibleSessionSeen`
      // on the settled render, which relays it to every window (a local clear here would
      // swallow the relay).
      if (!data.windowFocusedOnce || data.windowFocused || next.focusFlashOn) return next
      return armFlash(next)
    }),

  markVisibleSessionSeen: () => {
    // The session on screen in THIS window right now: its task's active tab, in this
    // window, with the window focused. `isSessionFocused` is the same on-screen
    // predicate `sessionDisplayState` uses to suppress the dot — so a session watched
    // to completion in place has its flag cleared the moment focus is settled, and the
    // cue never resurfaces when the user switches away (§9.5, "watched it finish").
    const data = get()
    const taskId = data.activeTaskId
    if (!taskId) return undefined
    const sid = activeSessionInWindow(data, taskId, data.windowId)
    if (!sid || !data.hasUnseenFinishedTurn[sid]) return undefined
    if (!isSessionFocused(data, sid)) return undefined
    set({ hasUnseenFinishedTurn: clearReady(data.hasUnseenFinishedTurn, sid) })
    // Report the id so the caller relays "seen" cross-window (§9.5): the main window's
    // task rollup folds over sessions in any window but can't see this window's focus.
    return sid
  },

  toggleDebugOverlay: () => set((data) => ({ debugOverlayOpen: !data.debugOverlayOpen })),

  endFocusFlash: (seq) =>
    set((data) =>
      data.focusFlashOn && data.focusFlashSeq === seq ? { focusFlashOn: false } : data
    ),

  toggleIssuesDrawer: () => set(toggleDrawerData),

  openIssuesDrawer: (issueId) => set((data) => openDrawerData(data, issueId)),

  setIssuesDrawerTab: (tab) =>
    set((data) => (data.issuesDrawerTab === tab ? data : { issuesDrawerTab: tab })),

  selectIssue: (id) => set((data) => selectIssueData(data, id)),

  startNewIssue: () => set(startNewIssueData),

  setIssueEditDirty: (dirty) =>
    set((data) => (data.issueEditDirty === dirty ? data : { issueEditDirty: dirty })),

  confirmDiscard: () => set(confirmDiscardData),

  cancelDiscard: () => set({ discardPrompt: null }),

  cancelNewIssue: () =>
    set((data) => bumpSession({ ...data, issueDraft: false, issueEditDirty: false })),
  // Like `setActiveSession` minus its local ready-for-review clear (§9.5): a pane focus
  // sends no `sessions.switch`, so a local clear would be the ONLY clear — other windows'
  // rollups would keep the flag. Leaving it set lets `markVisibleSessionSeen` (re-run by
  // the moved mark) clear it here and relay "seen" to every window. A pure mark move — it
  // never touches a group (DESIGN §5.7, split-groups design).
  focusPane: (sessionId) =>
    set((data) => {
      const session = data.sessions[sessionId]
      if (!session || session.windowId !== data.windowId) return data
      return withMark(data, session.taskId, sessionId)
    }),

  openSettings: () => set({ settingsOpen: true }),

  closeSettings: () => set({ settingsOpen: false })
}))

/** Return `map` with `sessionId` cleared, or `map` unchanged if it wasn't set (§9.5). */
function clearReady(
  map: Readonly<Record<string, boolean>>,
  sessionId: string
): Readonly<Record<string, boolean>> {
  if (!map[sessionId]) return map
  return omit(map, sessionId)
}
