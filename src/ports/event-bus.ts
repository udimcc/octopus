/**
 * The domain event bus (DESIGN §6.6, §8). Adapters do I/O off the single-writer
 * command loop and feed results back as events; the application publishes
 * lifecycle events that the main process forwards to the renderer (§6.5).
 *
 * The union already carries `sessionStateChanged`/`taskStateChanged` — the §10
 * V1 seam. Nobody emits them in V1 (Terminal lacks `EvaluatesState`), but the
 * bus, the IPC event DTO and the store all understand them, so V2 only has to
 * start *emitting* them. Signatures do not change across versions.
 *
 * `ptyData` also flows over this bus. It is high-frequency; the main-process
 * forwarder sends it via `webContents.send` so it never blocks command replies
 * (§6.5), and the renderer routes it straight to the terminal, bypassing the
 * store (§5.2).
 */

import type { TaskId, SessionId, WindowId, IssueId } from '../domain/ids'
import type { SessionState, TaskState } from '../domain/state'
import type {
  TaskSnapshot,
  SessionSnapshot,
  IssueSnapshot,
  GroupSnapshot
} from '../domain/snapshots'
import type { StateChangeMeta } from './session-runtime'

/** High-frequency terminal output for one session (§6.5, §5.2). */
export interface PtyDataEvent {
  readonly type: 'ptyData'
  readonly sessionId: SessionId
  readonly data: string
}

// ── Session lifecycle events (§6.5) ────────────────────────────────────────────

export interface SessionCreatedEvent {
  readonly type: 'sessionCreated'
  readonly taskId: TaskId
  readonly session: SessionSnapshot
  /** Created via the octopus-cli control socket: the renderer must not move the mark/active task. */
  readonly background?: boolean
}
export interface SessionExitedEvent {
  readonly type: 'sessionExited'
  readonly taskId: TaskId
  readonly sessionId: SessionId
  readonly exitCode?: number
}
export interface SessionClosedEvent {
  readonly type: 'sessionClosed'
  readonly taskId: TaskId
  readonly sessionId: SessionId
}
export interface SessionRenamedEvent {
  readonly type: 'sessionRenamed'
  readonly taskId: TaskId
  readonly sessionId: SessionId
  readonly title: string
}
export interface SessionReorderedEvent {
  readonly type: 'sessionReordered'
  readonly taskId: TaskId
  readonly orderedSessionIds: readonly SessionId[]
}

/**
 * A task's split groups changed (DESIGN §5.7). Published by: `joinGroup`,
 * `leaveGroup`, `ungroup`, `reorderGroup`, `resizeGroup`; `openSession`'s split
 * path (`CreateSessionInput.split`), which can join the brand-new session into a
 * group in the same command; and `closeSession`, whenever removing a session's
 * leaf dissolves or shrinks a group it belonged to. `closeWindow` itself never
 * publishes this directly: its `kill-sessions` disposition routes every hosted
 * session through `closeSession` (which publishes as above), and its
 * `move-to-main` disposition never touches group membership at all — a group's
 * tree/color is untouched by a window move (only each member's `windowId`
 * changes), so nothing publishes there. Carries the task's FULL group list (not
 * a delta), mirroring `GroupsChangedEventDTO`. Not session-scoped:
 * `window-registry` broadcasts it to every window.
 */
export interface GroupsChangedEvent {
  readonly type: 'groupsChanged'
  readonly taskId: TaskId
  readonly groups: readonly GroupSnapshot[]
}

// ── Task lifecycle events (§6.5) ────────────────────────────────────────────────

export interface TaskCreatedEvent {
  readonly type: 'taskCreated'
  readonly task: TaskSnapshot
  /** Originated from the octopus-cli control socket: the New-Task modal and toaster ignore it. */
  readonly background?: boolean
}
export interface TaskDeletedEvent {
  readonly type: 'taskDeleted'
  readonly taskId: TaskId
}
export interface TaskRenamedEvent {
  readonly type: 'taskRenamed'
  readonly taskId: TaskId
  readonly name: string
}
export interface TaskReorderedEvent {
  readonly type: 'taskReordered'
  readonly orderedTaskIds: readonly TaskId[]
}
export interface TaskStaleEvent {
  readonly type: 'taskStale'
  readonly taskId: TaskId
}
export interface ActiveTaskChangedEvent {
  readonly type: 'activeTaskChanged'
  readonly taskId?: TaskId
}
/**
 * The active session (visible tab) of a task changed (§5.4). Broadcast to ALL
 * windows so cross-window session switching works: sessions of one task can live in
 * different windows, so a `Ctrl+Shift+Arrow` cycle can land on a session hosted
 * elsewhere. Every window receives it, but only the window that HOSTS the session
 * (`windowId`) moves its mark (and `activeTaskId`) and raises itself to the OS
 * foreground; non-host windows keep displaying their own marked session. All windows
 * apply the global ready-for-review clear for the session (§9.5).
 */
export interface ActiveSessionChangedEvent {
  readonly type: 'activeSessionChanged'
  readonly taskId: TaskId
  readonly sessionId: SessionId
  readonly windowId: WindowId
}

// ── Script progress/error (worktree create/delete) (§6.4) ────────────────────────

export interface ScriptProgressEvent {
  readonly type: 'scriptProgress'
  readonly taskId: TaskId
  readonly line: string
  /** Originated from the octopus-cli control socket: the New-Task modal and toaster ignore it. */
  readonly background?: boolean
}
export interface ScriptErrorEvent {
  readonly type: 'scriptError'
  readonly taskId: TaskId
  readonly script: string
  readonly exitCode: number | null
  readonly stderr: string
  /** Originated from the octopus-cli control socket: the New-Task modal and toaster ignore it. */
  readonly background?: boolean
}

/** Generic non-fatal error surfaced to the UI as a toast (§5.4). */
export interface ErrorEvent {
  readonly type: 'error'
  readonly message: string
  readonly taskId?: TaskId
  readonly sessionId?: SessionId
  /** Originated from the octopus-cli control socket: the New-Task modal and toaster ignore it. */
  readonly background?: boolean
}

// ── Window lifecycle events (V1.5, §6.7) ──────────────────────────────────────────

export interface WindowCreatedEvent {
  readonly type: 'windowCreated'
  readonly windowId: WindowId
  readonly role: 'main' | 'secondary' | 'view'
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /** Set only when `role === 'view'` — the task this view window is pinned to. */
  readonly taskId?: TaskId
  /** Set only on a secondary of a VIEW: that view's id. Main's secondaries leave it unset. */
  readonly parentWindowId?: WindowId
}
export interface WindowClosedEvent {
  readonly type: 'windowClosed'
  readonly windowId: WindowId
}
export interface SessionMovedToWindowEvent {
  readonly type: 'sessionMovedToWindow'
  readonly sessionId: SessionId
  readonly taskId: TaskId
  readonly fromWindowId: WindowId
  readonly toWindowId: WindowId
  /**
   * Set when the move is NOT the one the user directly targeted, so the receiving
   * renderer KEEPS its existing mark for the task instead of marking the moved
   * session; an explicit drag / "Move to" (no cause) marks the moved session in the
   * target window.
   *  - `'windowClosed'`: the "move sessions to main" disposition of closing a window
   *    (§6.7).
   *  - `'groupMove'` (DESIGN §5.7): an EXTRA member riding along because the user
   *    moved/detached one member of its group and the whole group moves together —
   *    the target marks only the member that was directly sent, not these.
   */
  readonly cause?: 'windowClosed' | 'groupMove'
}

// ── View lifecycle events (window-view feature) ───────────────────────────────────

/** A task's dedicated view window was created ("New Window From Task"). */
export interface ViewCreatedEvent {
  readonly type: 'viewCreated'
  readonly windowId: WindowId
  readonly taskId: TaskId
}
/** A task's view window was closed; its sessions returned to main (or, on task delete, were deleted with the task). */
export interface ViewClosedEvent {
  readonly type: 'viewClosed'
  readonly windowId: WindowId
  readonly taskId: TaskId
}

// ── Issue lifecycle events ("Issues", §13.3) ──────────────────────────────────────

/** An issue was created or changed (create/update/bind/unbind, or a cascading effect
 * like `removeProject` clearing its project, or `deleteTask` unbinding it). */
export interface IssueUpsertedEvent {
  readonly type: 'issueUpserted'
  readonly issue: IssueSnapshot
}
export interface IssueDeletedEvent {
  readonly type: 'issueDeleted'
  readonly issueId: IssueId
}

// ── Dormant V2 state seams (§10 V1) — emitted by nobody in V1 ─────────────────────

export interface SessionStateChangedEvent {
  readonly type: 'sessionStateChanged'
  readonly sessionId: SessionId
  readonly state: SessionState
  /** Layer/confidence/reason of the deciding signal (§9.1) — feeds the debug overlay. */
  readonly meta?: StateChangeMeta
}
export interface TaskStateChangedEvent {
  readonly type: 'taskStateChanged'
  readonly taskId: TaskId
  readonly state: TaskState
}

/** Every event that can flow over the bus. Discriminated on `type`. */
export type DomainEvent =
  | PtyDataEvent
  | SessionCreatedEvent
  | SessionExitedEvent
  | SessionClosedEvent
  | SessionRenamedEvent
  | SessionReorderedEvent
  | GroupsChangedEvent
  | TaskCreatedEvent
  | TaskDeletedEvent
  | TaskRenamedEvent
  | TaskReorderedEvent
  | TaskStaleEvent
  | ActiveTaskChangedEvent
  | ActiveSessionChangedEvent
  | ScriptProgressEvent
  | ScriptErrorEvent
  | ErrorEvent
  | WindowCreatedEvent
  | WindowClosedEvent
  | SessionMovedToWindowEvent
  | ViewCreatedEvent
  | ViewClosedEvent
  | IssueUpsertedEvent
  | IssueDeletedEvent
  | SessionStateChangedEvent
  | TaskStateChangedEvent

export type EventHandler = (event: DomainEvent) => void
export type Unsubscribe = () => void

export interface EventBus {
  publish(event: DomainEvent): void
  subscribe(handler: EventHandler): Unsubscribe
}
