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
import type { TaskSnapshot, SessionSnapshot, IssueSnapshot } from '../domain/snapshots'
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

// ── Task lifecycle events (§6.5) ────────────────────────────────────────────────

export interface TaskCreatedEvent {
  readonly type: 'taskCreated'
  readonly task: TaskSnapshot
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
}
export interface ScriptErrorEvent {
  readonly type: 'scriptError'
  readonly taskId: TaskId
  readonly script: string
  readonly exitCode: number | null
  readonly stderr: string
}

/** Generic non-fatal error surfaced to the UI as a toast (§5.4). */
export interface ErrorEvent {
  readonly type: 'error'
  readonly message: string
  readonly taskId?: TaskId
  readonly sessionId?: SessionId
}

// ── Window lifecycle events (V1.5, §6.7) ──────────────────────────────────────────

export interface WindowCreatedEvent {
  readonly type: 'windowCreated'
  readonly windowId: WindowId
  readonly role: 'main' | 'secondary'
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
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
   * Set when the move is the "move sessions to main" disposition of closing a window
   * (§6.7). The receiving renderer then KEEPS its existing mark for the task instead of
   * marking the moved session; an explicit drag / "Move to" (no cause) marks the moved
   * session in the target window.
   */
  readonly cause?: 'windowClosed'
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
