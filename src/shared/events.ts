/**
 * Wire events (backend → renderer), the DTO mirror of the domain `EventBus`'s
 * `DomainEvent` (`src/ports/event-bus.ts`). All flow over the single `app:event`
 * channel as a `type`-discriminated union; `main`'s window-registry maps each
 * `DomainEvent` to its `EventDTO` and routes it to the right window(s) (§6.5, §6.7).
 *
 * `ptyData` rides this same channel but the renderer routes it straight to the
 * terminal, bypassing the store (§5.2) — it never blocks command replies because
 * events are `send`, not `handle` (§6.5).
 *
 * The dormant `sessionStateChanged`/`taskStateChanged` members exist so V2 lights
 * up state without a signature change (§10); nobody emits them in V1.
 */

import type { TaskDTO, SessionDTO, IssueDTO } from './dto'

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
/**
 * A task's active session (visible tab) changed (§5.4). Broadcast to all windows so
 * session switching spans windows: only the hosting window (`windowId`) moves its
 * mark and raises itself; the others keep their own mark and apply the global
 * ready-for-review clear. The DTO mirror of `ActiveSessionChangedEvent`.
 */
export interface ActiveSessionChangedEventDTO {
  readonly type: 'activeSessionChanged'
  readonly taskId: string
  readonly sessionId: string
  readonly windowId: string
}

// ── Issue events ("Issues", §13.3) ───────────────────────────────────────────

/** An issue was created or changed (create, update, bind, unbind). DTO mirror of `IssueUpsertedEvent`. */
export interface IssueUpsertedEventDTO {
  readonly type: 'issueUpserted'
  readonly issue: IssueDTO
}
/** An issue was deleted. DTO mirror of `IssueDeletedEvent`. */
export interface IssueDeletedEventDTO {
  readonly type: 'issueDeleted'
  readonly issueId: string
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

// ── Window lifecycle events (V1.5, §6.7) ─────────────────────────────────────

export interface WindowCreatedEventDTO {
  readonly type: 'windowCreated'
  readonly windowId: string
  readonly role: 'main' | 'secondary'
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}
export interface WindowClosedEventDTO {
  readonly type: 'windowClosed'
  readonly windowId: string
}
export interface SessionMovedToWindowEventDTO {
  readonly type: 'sessionMovedToWindow'
  readonly sessionId: string
  readonly taskId: string
  readonly fromWindowId: string
  readonly toWindowId: string
  /**
   * Set when the move is the "move sessions to main" disposition of closing a window
   * (§6.7). The receiving renderer then KEEPS its existing mark for the task instead of
   * marking the moved session; an explicit drag / "Move to" (no cause) marks the moved
   * session in the target window.
   */
  readonly cause?: 'windowClosed'
}

// ── Dormant V2 state seams (§10) — emitted by nobody in V1 ───────────────────

export interface SessionStateChangedEventDTO {
  readonly type: 'sessionStateChanged'
  readonly sessionId: string
  readonly state: string
  /**
   * Layer/confidence/reason of the deciding signal (§9.1, §9.3) — powers the
   * keyboard-toggled debug overlay (§11) and low-confidence dimming. All optional
   * strings so the wire contract stays transport-agnostic (no domain enums leak).
   */
  readonly layer?: 1 | 2 | 3
  readonly confidence?: string
  readonly reason?: string
  readonly subState?: string
}
export interface TaskStateChangedEventDTO {
  readonly type: 'taskStateChanged'
  readonly taskId: string
  readonly state: string
}

/**
 * An in-app notification that a session's status changed (§9.5). Unlike
 * `sessionStateChanged`, this rides its OWN direct delivery: the composition root
 * routes it only to the ACTIVE window (main-window fallback) via the window
 * registry — it is never published on the domain bus, so it never broadcasts. It
 * carries only the already-resolved task/session NAMES: the toast says just "state
 * changed" (no from/to), so the user checks the session themselves rather than the
 * notification depending on Claude's hook timing to reconstruct a delta.
 */
export interface SessionStateNotificationEventDTO {
  readonly type: 'sessionStateNotification'
  readonly sessionId: string
  readonly taskName: string
  readonly sessionName: string
}

/**
 * A finished-turn session was WATCHED IN PLACE and is now seen (§9.5). Broadcast to
 * ALL windows so the "unseen finished turn" view-model (`hasUnseenFinishedTurn`)
 * clears everywhere. The hosting window observes the watch-in-place locally (its
 * `markVisibleSessionSeen`), but a turn finished in place fires no focus *transition*
 * to broadcast — and the main window's task rollup folds over sessions in ANY window
 * yet knows only its OWN focus, so without this relay its rollup stayed stuck on
 * `review` for a session watched-to-idle in another window (was a documented known
 * limitation). Like `sessionStateNotification`, it is SYNTHESIZED in main and routed
 * directly, never published on the domain bus: "seen" is a pure renderer view-model,
 * not a domain fact (nothing persists, no `TaskState` recompute).
 */
export interface SessionSeenEventDTO {
  readonly type: 'sessionSeen'
  readonly sessionId: string
}

/**
 * The Issues drawer should toggle open/closed ("Issues", §13.4). Routed to the MAIN
 * window only, in response to `issue:toggleDrawer` sent from a secondary window (main
 * then raises/focuses the main window). Like `sessionSeen`, it is
 * SYNTHESIZED in main and routed directly, never published on the domain bus: drawer
 * open/closed is a pure renderer view-state, not a domain fact.
 */
export interface IssuesDrawerToggleEventDTO {
  readonly type: 'issuesDrawerToggle'
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
  | ActiveSessionChangedEventDTO
  | IssueUpsertedEventDTO
  | IssueDeletedEventDTO
  | ScriptProgressEventDTO
  | ScriptErrorEventDTO
  | ErrorEventDTO
  | WindowCreatedEventDTO
  | WindowClosedEventDTO
  | SessionMovedToWindowEventDTO
  | SessionStateChangedEventDTO
  | TaskStateChangedEventDTO
  | SessionStateNotificationEventDTO
  | SessionSeenEventDTO
  | IssuesDrawerToggleEventDTO
