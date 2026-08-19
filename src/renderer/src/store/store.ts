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
  WindowDTO
} from '../../../shared/dto'
import type { EventDTO } from '../../../shared/events'
import { type DisplayState, DISPLAY_RANK } from './display-state'

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
  /** task id → the session tab shown when that task is active. */
  readonly activeSessionByTask: Readonly<Record<string, string>>
  readonly sessionTypes: readonly SessionTypeDTO[]
  readonly settings: SettingsDTO
  readonly version: number
  readonly toasts: readonly Toast[]
  /** Monotonic toast id source (kept in state so it survives without Date/random). */
  readonly nextToastId: number
  /** Which window this renderer is (V1.5, §5.6); filters the session view. */
  readonly windowId: string
  /** `main` → owns the progress panel; `secondary` → session-only. */
  readonly windowRole: 'main' | 'secondary'
  /** All open windows (V1.5, §6.7); patched by window lifecycle events. */
  readonly windows: readonly WindowDTO[]
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
}

export interface StoreActions {
  hydrate(state: WindowedWorkspaceStateDTO): void
  applyEvent(event: EventDTO): void
  setActiveTask(taskId: string): void
  setActiveSession(taskId: string, sessionId: string): void
  /**
   * Optimistically flip the group-by-repo view preference in place (§5.1). The
   * caller persists it via `app.updateSettings`; unlike the SettingsModal we do
   * NOT re-hydrate the whole workspace for a one-click view toggle (that would
   * reset toasts), so this patches just the one settings field.
   */
  setGroupTasksByRepo(value: boolean): void
  pushToast(kind: ToastKind, message: string): void
  dismissToast(id: number): void
  /** Record this window's OS focus (§9.5); regaining focus clears the active tab's flag. */
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
   */
  markVisibleSessionSeen(): string | undefined
  /** Toggle the keyboard-triggered debug overlay for this window (§11). */
  toggleDebugOverlay(): void
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
  pasteKey: 'Ctrl+Shift+KeyV'
}

/** The empty projection before hydration (also used to reset the store in tests). */
export function initialData(): StoreData {
  return {
    tasks: {},
    sessions: {},
    taskOrder: [],
    activeTaskId: undefined,
    activeSessionByTask: {},
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
    debugTransitions: [],
    nextDebugSeq: 1,
    debugOverlayOpen: false
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

function hydrateData(state: WindowedWorkspaceStateDTO): StoreData {
  const base = initialData()
  const tasks: Record<string, TaskEntry> = {}
  const sessions: Record<string, SessionDTO> = {}
  const activeSessionByTask: Record<string, string> = {}

  const ordered = [...state.tasks].sort((a, b) => a.position - b.position)
  for (const t of ordered) {
    const { entry, sessions: ss } = normalizeTask(t)
    tasks[entry.id] = entry
    for (const s of ss) sessions[s.id] = s
    if (entry.activeSessionId) activeSessionByTask[entry.id] = entry.activeSessionId
    else if (ss.length > 0) activeSessionByTask[entry.id] = ss[0].id
  }

  return {
    ...base,
    tasks,
    sessions,
    taskOrder: ordered.map((t) => t.id),
    activeTaskId: state.activeTaskId,
    activeSessionByTask,
    sessionTypes: state.sessionTypes,
    settings: state.settings,
    version: state.version,
    windowId: state.thisWindowId,
    windowRole: state.thisWindowRole,
    windows: state.windows
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
 * The session to show for a task IN this window: the window-scoped active tab if it
 * still lives here, else the first windowed session (the global `activeSessionByTask`
 * may point at a session that lives in another window). `undefined` → this window
 * hosts none of the task's sessions (renders an empty pane area).
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
 * Is `sessionId` currently FOCUSED from this renderer's vantage (§9.5)? True only
 * when it is the session actually ON SCREEN: its task is the active task, it is that
 * task's active tab, it is hosted in THIS window, and this window has OS focus. A
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
  return data.activeSessionByTask[session.taskId] === sessionId
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
    if (next.activeSessionByTask[taskId] === sessionId) {
      const activeSessionByTask = { ...next.activeSessionByTask }
      const fallback = sessionIds[sessionIds.length - 1]
      if (fallback) activeSessionByTask[taskId] = fallback
      else delete activeSessionByTask[taskId]
      next = { ...next, activeSessionByTask }
    }
    // The removed session no longer contributes to the task rollup — recompute its
    // worst-wins state so a closed `Working`/`NeedsInput` session stops pinning the
    // task icon to a stale rank (§3.4).
    next = recomputeTaskState(next, taskId)
  }
  return next
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
      const activeSessionByTask = { ...data.activeSessionByTask }
      // Derive the visible tab for a task that arrives carrying sessions
      // (reconciled/hydrated tasks); a fresh task has none, so nothing to set.
      const preferred = entry.activeSessionId ?? entry.sessionIds[0]
      if (preferred && !activeSessionByTask[entry.id]) activeSessionByTask[entry.id] = preferred
      return {
        ...data,
        tasks: { ...data.tasks, [entry.id]: entry },
        sessions,
        activeSessionByTask,
        taskOrder: isNew ? [...data.taskOrder, entry.id] : data.taskOrder
      }
    }

    case 'taskDeleted': {
      const tasks = omit(data.tasks, event.taskId)
      const activeSessionByTask = omit(data.activeSessionByTask, event.taskId)
      const doomed = data.tasks[event.taskId]?.sessionIds ?? []
      const sessions = { ...data.sessions }
      for (const id of doomed) delete sessions[id]
      return {
        ...data,
        tasks,
        sessions,
        activeSessionByTask,
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

    case 'activeTaskChanged': {
      // Switching to a task focuses its globally-active session, so the user has now
      // looked at it — clear its ready-for-review flag (§9.5). GLOBAL + unconditional,
      // mirroring activeSessionChanged: broadcast to every window on a deliberate switch,
      // and the main-window task rollup (`taskDisplayState`) folds over sessions in ANY
      // window, so a guarded or per-window clear would leave the dot lit. Target the
      // replicated global pointer (`activeSessionByTask[taskId]`, identical in every
      // window) so all windows drop the SAME session and the rollup stays consistent.
      const next: StoreData = { ...data, activeTaskId: event.taskId }
      const active = event.taskId ? data.activeSessionByTask[event.taskId] : undefined
      if (!active) return next
      return { ...next, hasUnseenFinishedTurn: clearReady(next.hasUnseenFinishedTurn, active) }
    }

    case 'activeSessionChanged': {
      // Broadcast to every window so cross-window session switching works (§5.4):
      // a task's sessions can live in different windows, so the cycle can land on a
      // session hosted elsewhere. All windows move the tab pointer; the window that
      // HOSTS the session (`event.windowId === thisWindowId`) also makes the task
      // active so its `TaskView` is the one on screen when the OS raises it (the
      // raise itself is done in main).
      //
      // The ready-for-review CLEAR is GLOBAL, not host-only (§9.5): switching to a
      // session focuses and raises its host window (composition-root), so the user has
      // now looked at it. The flag must clear in EVERY window's store — the task rollup
      // (`taskDisplayState`) is shown only in the main window yet folds over sessions
      // hosted in ANY window, so a host-only clear left the main window's task dot lit
      // after the user focused a session living in another window.
      const hosting = event.windowId === data.windowId
      const next: StoreData = {
        ...data,
        activeSessionByTask: { ...data.activeSessionByTask, [event.taskId]: event.sessionId },
        activeTaskId: hosting ? event.taskId : data.activeTaskId,
        hasUnseenFinishedTurn: clearReady(data.hasUnseenFinishedTurn, event.sessionId)
      }
      return next
    }

    case 'sessionCreated': {
      const s = event.session
      const task = data.tasks[event.taskId]
      const next: StoreData = { ...data, sessions: { ...data.sessions, [s.id]: s } }
      if (!task) return next
      const sessionIds = task.sessionIds.includes(s.id)
        ? task.sessionIds
        : [...task.sessionIds, s.id]
      return {
        ...patchTask(next, event.taskId, { sessionIds }),
        activeSessionByTask: { ...next.activeSessionByTask, [event.taskId]: s.id }
      }
    }

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
        return { ...next, hasUnseenFinishedTurn: clearReady(next.hasUnseenFinishedTurn, event.sessionId) }
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
      const s = data.sessions[event.sessionId]
      if (!s) return data
      return {
        ...data,
        sessions: { ...data.sessions, [event.sessionId]: { ...s, windowId: event.toWindowId } }
      }
    }

    case 'windowCreated': {
      // Track the new window (§6.7). Upsert-safe: ignore a duplicate id.
      if (data.windows.some((w) => w.id === event.windowId)) return data
      const win: WindowDTO = {
        id: event.windowId,
        role: event.role,
        bounds: event.bounds,
        createdAt: 0
      }
      return { ...data, windows: [...data.windows, win] }
    }

    case 'windowClosed':
      return { ...data, windows: data.windows.filter((w) => w.id !== event.windowId) }

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

  hydrate: (state) => set(hydrateData(state)),

  applyEvent: (event) =>
    set((data) => reduceEvent(data, event, notificationThrottle.admit)),

  setActiveTask: (taskId) =>
    set((data) => {
      // Immediate same-window feedback before the tasks.switch round-trip lands the
      // broadcast activeTaskChanged — and the only clear when the target is already the
      // workspace-active task (switchTask skips the event then). Mirrors setActiveSession:
      // focusing a task clears its globally-active session's ready-for-review flag (§9.5).
      const active = data.activeSessionByTask[taskId]
      if (!active) return { activeTaskId: taskId }
      return { activeTaskId: taskId, hasUnseenFinishedTurn: clearReady(data.hasUnseenFinishedTurn, active) }
    }),

  setActiveSession: (taskId, sessionId) =>
    set((data) => ({
      activeSessionByTask: { ...data.activeSessionByTask, [taskId]: sessionId },
      // Focusing a session is the ONLY clear path for its ready-for-review flag (§9.5).
      hasUnseenFinishedTurn: clearReady(data.hasUnseenFinishedTurn, sessionId)
    })),

  setGroupTasksByRepo: (value) =>
    set((data) => ({ settings: { ...data.settings, groupTasksByRepo: value } })),

  pushToast: (kind, message) => set((data) => pushToastData(data, kind, message)),

  dismissToast: (id) => set((data) => ({ toasts: data.toasts.filter((t) => t.id !== id) })),

  setWindowFocused: (focused) =>
    set((data) => {
      if (data.windowFocused === focused) return data
      const next = { ...data, windowFocused: focused }
      // Regaining focus counts as "looking at" the currently-visible session (§9.5) —
      // the same clear path as an explicit tab click. Nothing to clear on blur.
      if (!focused) return next
      const activeTaskId = data.activeTaskId
      const visible = activeTaskId
        ? activeSessionInWindow(next, activeTaskId, data.windowId)
        : undefined
      if (!visible) return next
      return { ...next, hasUnseenFinishedTurn: clearReady(data.hasUnseenFinishedTurn, visible) }
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
    const sid = data.activeSessionByTask[taskId]
    if (!sid || !data.hasUnseenFinishedTurn[sid]) return undefined
    if (!isSessionFocused(data, sid)) return undefined
    set({ hasUnseenFinishedTurn: clearReady(data.hasUnseenFinishedTurn, sid) })
    // Report the id so the caller relays "seen" cross-window (§9.5): the main window's
    // task rollup folds over sessions in any window but can't see this window's focus.
    return sid
  },

  toggleDebugOverlay: () => set((data) => ({ debugOverlayOpen: !data.debugOverlayOpen }))
}))

/** Return `map` with `sessionId` cleared, or `map` unchanged if it wasn't set (§9.5). */
function clearReady(
  map: Readonly<Record<string, boolean>>,
  sessionId: string
): Readonly<Record<string, boolean>> {
  if (!map[sessionId]) return map
  return omit(map, sessionId)
}
