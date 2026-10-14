/**
 * `Session` entity (DESIGN §3.2, §3.6). Lives inside the `Task` aggregate; all
 * mutations go through `Task` except the lifecycle/state transitions the runtime
 * drives, which are applied here and guarded by the transition table (§3.6).
 *
 * `SessionLifecycle` ("is the runtime alive?") is orthogonal to `SessionState`
 * ("what is it doing?", V2+). In V1 `state` never leaves `Unknown`.
 */

import type { TaskId, SessionId, TypeId, WindowId } from './ids'
import { MAIN_WINDOW_ID } from './ids'
import { SessionState } from './state'
import { SessionLifecycle, canTransitionSession, lifecycleToAggregationState } from './lifecycle'
import type { SessionConfig } from './session-config'
import type { SessionSnapshot } from './snapshots'
import { IllegalTransitionError } from './errors'

export interface SessionCreateProps {
  id: SessionId
  taskId: TaskId
  typeId: TypeId
  title: string
  config: SessionConfig
  order: number
  createdAt: number
}

export class Session {
  readonly id: SessionId
  readonly taskId: TaskId
  readonly typeId: TypeId
  readonly config: SessionConfig
  readonly createdAt: number

  private _title: string
  private _lifecycle: SessionLifecycle
  private _state: SessionState
  private _order: number
  private _exitedAt?: number
  /** Which window renders this session (V1.5, §3.7). Opaque; defaults to main. */
  private _windowId: WindowId

  private constructor(props: SessionCreateProps, lifecycle: SessionLifecycle) {
    this.id = props.id
    this.taskId = props.taskId
    this.typeId = props.typeId
    this.config = props.config
    this.createdAt = props.createdAt
    this._title = props.title
    this._lifecycle = lifecycle
    this._state = SessionState.Unknown
    this._order = props.order
    this._windowId = MAIN_WINDOW_ID
  }

  /** Create a session in `Created` (§3.6: `[None] → Created`). */
  static create(props: SessionCreateProps): Session {
    return new Session(props, SessionLifecycle.Created)
  }

  /**
   * Reconstruct a session from a persisted snapshot without replaying the
   * lifecycle (I15). Used by `Workspace.hydrate` on startup.
   */
  static fromSnapshot(snap: SessionSnapshot): Session {
    const s = new Session(
      {
        id: snap.id,
        taskId: snap.taskId,
        typeId: snap.typeId,
        title: snap.title,
        config: snap.config,
        order: snap.order,
        createdAt: snap.createdAt
      },
      snap.lifecycle
    )
    s._state = snap.state
    s._exitedAt = snap.exitedAt
    // Pre-V1.5 snapshots have no windowId → default to the main window (I18).
    s._windowId = snap.windowId ?? MAIN_WINDOW_ID
    return s
  }

  get title(): string {
    return this._title
  }
  get lifecycle(): SessionLifecycle {
    return this._lifecycle
  }
  get state(): SessionState {
    return this._state
  }
  get order(): number {
    return this._order
  }
  get windowId(): WindowId {
    return this._windowId
  }

  rename(title: string): void {
    this._title = title
  }

  /**
   * Apply a freshly-evaluated {@link SessionState} (§3.3, phase 2). Orthogonal to
   * lifecycle — this is "what is it doing?", set by the runtime's state evaluator
   * via the `ingestSessionState` command. A no-op-shaped setter: aggregation reads
   * it through {@link aggregationState}, which still honors the I12 lifecycle
   * overrides (an Exited session contributes `Blocked` regardless of `_state`).
   */
  setState(state: SessionState): void {
    this._state = state
  }

  setOrder(order: number): void {
    this._order = order
  }

  /**
   * Reassign the window that renders this session (V1.5, §3.7, I18). An opaque
   * view move: `taskId` (I7) and lifecycle are untouched, so the PTY — keyed by
   * `sessionId` in main — keeps running. Mirrors `rename`/`setOrder` (in-place).
   *
   * Public so `Task.moveToWindow` can call it per-member, but callers outside
   * `Task` should go through `Task.moveToWindow` rather than this directly — a
   * grouped session's whole group must move together (DESIGN §5.7 "members
   * share a window"), an invariant `Task` enforces, not `Session` (review I2).
   */
  assignToWindow(windowId: WindowId): void {
    this._windowId = windowId
  }

  private transition(to: SessionLifecycle): void {
    if (!canTransitionSession(this._lifecycle, to)) {
      throw new IllegalTransitionError(
        `session ${this.id}: illegal transition ${this._lifecycle} → ${to}`
      )
    }
    this._lifecycle = to
  }

  /** `Created → Starting`: config validated, runtime about to start (§3.6). */
  markStarting(): void {
    this.transition(SessionLifecycle.Starting)
  }

  /** `Starting → Running`: runtime.start() succeeded (§3.6). */
  markRunning(): void {
    this.transition(SessionLifecycle.Running)
  }

  /** `Running → Stopping`: user-driven close in progress (§3.6). */
  markStopping(): void {
    this.transition(SessionLifecycle.Stopping)
  }

  /** `Stopping → Closed`: runtime disposed by a user close (§3.6). */
  markClosed(): void {
    this.transition(SessionLifecycle.Closed)
  }

  /**
   * `Running/Stopping → Exited`: the process died (runtime `onExit`). Distinct
   * from `Closed`, which is a user-driven close (§6.1). Records the exit time so
   * scrollback and final output remain readable.
   */
  markExited(exitedAt: number): void {
    this.transition(SessionLifecycle.Exited)
    this._exitedAt = exitedAt
  }

  /** `Starting → StartFailed`: runtime.start() threw (§3.6). */
  markStartFailed(): void {
    this.transition(SessionLifecycle.StartFailed)
  }

  /** `Created → CreateFailed`: config validation failed (§3.6). */
  markCreateFailed(): void {
    this.transition(SessionLifecycle.CreateFailed)
  }

  /**
   * The {@link SessionState} this session contributes to task aggregation,
   * accounting for I12 (Exited/StartFailed → Blocked). Always `Unknown` for a
   * live V1 session.
   */
  aggregationState(): SessionState {
    return lifecycleToAggregationState(this._lifecycle, this._state)
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      taskId: this.taskId,
      typeId: this.typeId,
      title: this._title,
      config: this.config,
      lifecycle: this._lifecycle,
      state: this._state,
      order: this._order,
      createdAt: this.createdAt,
      exitedAt: this._exitedAt,
      windowId: this._windowId
    }
  }
}
