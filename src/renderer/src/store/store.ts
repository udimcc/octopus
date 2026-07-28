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

/** Normalized task record: task-level metadata + an ordered list of session ids. */
export interface TaskEntry {
  readonly id: string
  readonly name: string
  readonly worktree?: WorktreeRefDTO
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
  readonly message: string
}

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
}

export interface StoreActions {
  hydrate(state: WindowedWorkspaceStateDTO): void
  applyEvent(event: EventDTO): void
  setActiveTask(taskId: string): void
  setActiveSession(taskId: string, sessionId: string): void
  pushToast(kind: ToastKind, message: string): void
  dismissToast(id: number): void
}

export type Store = StoreData & StoreActions

const DEFAULT_SETTINGS: SettingsDTO = {
  worktree: { location: '' },
  terminal: {},
  defaultSessionTypeId: 'terminal',
  sessionNextKey: 'Ctrl+Shift+ArrowRight',
  sessionPrevKey: 'Ctrl+Shift+ArrowLeft'
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
    windows: []
  }
}

/** Project a wire TaskDTO into the normalized {entry, sessions[]} pair. */
function normalizeTask(dto: TaskDTO): { entry: TaskEntry; sessions: SessionDTO[] } {
  const sessions = [...dto.sessions].sort((a, b) => a.order - b.order)
  const entry: TaskEntry = {
    id: dto.id,
    name: dto.name,
    worktree: dto.worktree,
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
  let next: StoreData = { ...data, sessions }
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
  }
  return next
}

/**
 * The pure event reducer. Returns the next `StoreData` for every wire event.
 * `ptyData` is ignored here (it bypasses the store, §5.2); the dormant
 * state-changed events (§10) patch the `state` field but nobody emits them in V1.
 */
export function reduceEvent(data: StoreData, event: EventDTO): StoreData {
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

    case 'activeTaskChanged':
      return { ...data, activeTaskId: event.taskId }

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
      const next: StoreData = {
        ...data,
        sessions: { ...data.sessions, [event.sessionId]: updated }
      }
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
      // Dormant seam (§10): patch the session's state field. Nobody emits this in V1.
      const s = data.sessions[event.sessionId]
      if (!s) return data
      return {
        ...data,
        sessions: { ...data.sessions, [event.sessionId]: { ...s, state: event.state } }
      }
    }

    case 'taskStateChanged':
      // Dormant seam (§10): patch the task's derived state. Unused in V1.
      return patchTask(data, event.taskId, { state: event.state })

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

function pushToastData(data: StoreData, kind: ToastKind, message: string): StoreData {
  const toast: Toast = { id: data.nextToastId, kind, message }
  return { ...data, toasts: [...data.toasts, toast], nextToastId: data.nextToastId + 1 }
}

export const useStore = create<Store>((set) => ({
  ...initialData(),

  hydrate: (state) => set(hydrateData(state)),

  applyEvent: (event) => set((data) => reduceEvent(data, event)),

  setActiveTask: (taskId) => set({ activeTaskId: taskId }),

  setActiveSession: (taskId, sessionId) =>
    set((data) => ({
      activeSessionByTask: { ...data.activeSessionByTask, [taskId]: sessionId }
    })),

  pushToast: (kind, message) => set((data) => pushToastData(data, kind, message)),

  dismissToast: (id) => set((data) => ({ toasts: data.toasts.filter((t) => t.id !== id) }))
}))
