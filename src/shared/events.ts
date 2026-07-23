/**
 * Wire events (backend → renderer), the DTO mirror of the domain `EventBus`'s
 * `DomainEvent` (`src/ports/event-bus.ts`). All flow over the single `app:event`
 * channel as a `type`-discriminated union; `main`'s event-forwarder maps each
 * `DomainEvent` to its `EventDTO` and `webContents.send`s it (§6.5).
 *
 * `ptyData` rides this same channel but the renderer routes it straight to the
 * terminal, bypassing the store (§5.2) — it never blocks command replies because
 * events are `send`, not `handle` (§6.5).
 *
 * The dormant `sessionStateChanged`/`taskStateChanged` members exist so V2 lights
 * up state without a signature change (§10); nobody emits them in V1.
 */

import type { TaskDTO, SessionDTO } from './dto'

export interface PtyDataEventDTO {
  readonly type: 'ptyData'
  readonly sessionId: string
  readonly data: string
}

export interface SessionCreatedEventDTO {
  readonly type: 'sessionCreated'
  readonly taskId: string
  readonly session: SessionDTO
}
export interface SessionExitedEventDTO {
  readonly type: 'sessionExited'
  readonly taskId: string
  readonly sessionId: string
  readonly exitCode?: number
}
export interface SessionClosedEventDTO {
  readonly type: 'sessionClosed'
  readonly taskId: string
  readonly sessionId: string
}
export interface SessionRenamedEventDTO {
  readonly type: 'sessionRenamed'
  readonly taskId: string
  readonly sessionId: string
  readonly title: string
}
export interface SessionReorderedEventDTO {
  readonly type: 'sessionReordered'
  readonly taskId: string
  readonly orderedSessionIds: readonly string[]
}

export interface TaskCreatedEventDTO {
  readonly type: 'taskCreated'
  readonly task: TaskDTO
}
export interface TaskDeletedEventDTO {
  readonly type: 'taskDeleted'
  readonly taskId: string
}
export interface TaskRenamedEventDTO {
  readonly type: 'taskRenamed'
  readonly taskId: string
  readonly name: string
}
export interface TaskReorderedEventDTO {
  readonly type: 'taskReordered'
  readonly orderedTaskIds: readonly string[]
}
export interface TaskStaleEventDTO {
  readonly type: 'taskStale'
  readonly taskId: string
}
export interface ActiveTaskChangedEventDTO {
  readonly type: 'activeTaskChanged'
  readonly taskId?: string
}

export interface ScriptProgressEventDTO {
  readonly type: 'scriptProgress'
  readonly taskId: string
  readonly line: string
}
export interface ScriptErrorEventDTO {
  readonly type: 'scriptError'
  readonly taskId: string
  readonly script: string
  readonly exitCode: number | null
  readonly stderr: string
}

export interface ErrorEventDTO {
  readonly type: 'error'
  readonly message: string
  readonly taskId?: string
  readonly sessionId?: string
}

// ── Dormant V2 state seams (§10) — emitted by nobody in V1 ───────────────────

export interface SessionStateChangedEventDTO {
  readonly type: 'sessionStateChanged'
  readonly sessionId: string
  readonly state: string
}
export interface TaskStateChangedEventDTO {
  readonly type: 'taskStateChanged'
  readonly taskId: string
  readonly state: string
}

/** Every event that can flow over the `app:event` channel. Discriminated on `type`. */
export type EventDTO =
  | PtyDataEventDTO
  | SessionCreatedEventDTO
  | SessionExitedEventDTO
  | SessionClosedEventDTO
  | SessionRenamedEventDTO
  | SessionReorderedEventDTO
  | TaskCreatedEventDTO
  | TaskDeletedEventDTO
  | TaskRenamedEventDTO
  | TaskReorderedEventDTO
  | TaskStaleEventDTO
  | ActiveTaskChangedEventDTO
  | ScriptProgressEventDTO
  | ScriptErrorEventDTO
  | ErrorEventDTO
  | SessionStateChangedEventDTO
  | TaskStateChangedEventDTO
