/**
 * `Task` aggregate root (DESIGN §3.1, §3.2, §3.5). The consistency boundary for
 * its sessions: every add/remove/reorder/state change goes through it, and it
 * derives `TaskState` (I11 — never assigned). Cross-aggregate references are by
 * id only (§3.1).
 *
 * A task holds a `WorktreeRef` only once `Ready` (I1); provisioning status lives
 * in `TaskLifecycle` (§3.5).
 */

import type { TaskId, SessionId } from './ids'
import { TaskState } from './state'
import { TaskLifecycle, canTransitionTask } from './lifecycle'
import { WorktreeRef } from './worktree-ref'
import { Session } from './session'
import type { TaskStateAggregator } from './task-state-aggregator'
import type { TaskSnapshot } from './snapshots'
import { IllegalTransitionError, InvariantViolationError } from './errors'

export interface TaskCreateProps {
  id: TaskId
  name: string
  position: number
  createdAt: number
}

export class Task {
  readonly id: TaskId
  readonly createdAt: number

  private _name: string
  private _lifecycle: TaskLifecycle
  private _worktree?: WorktreeRef
  private _sessions: Session[]
  private _activeSessionId?: SessionId
  private _position: number

  private constructor(props: TaskCreateProps, lifecycle: TaskLifecycle) {
    this.id = props.id
    this.createdAt = props.createdAt
    this._name = props.name
    this._lifecycle = lifecycle
    this._sessions = []
    this._position = props.position
  }

  /** Create a task in `None`; `createTask` immediately drives it to `Provisioning` (§3.5). */
  static create(props: TaskCreateProps): Task {
    return new Task(props, TaskLifecycle.None)
  }

  /** Reconstruct a task (and its sessions) from persistence (I15). */
  static fromSnapshot(snap: TaskSnapshot): Task {
    const t = new Task(
      { id: snap.id, name: snap.name, position: snap.position, createdAt: snap.createdAt },
      snap.lifecycle
    )
    if (snap.worktree) {
      t._worktree = WorktreeRef.create(snap.worktree)
    }
    t._sessions = snap.sessions
      .map((s) => Session.fromSnapshot(s))
      .sort((a, b) => a.order - b.order)
    // Restore the active session only if it still resolves to a held session (I10).
    if (snap.activeSessionId && t._sessions.some((s) => s.id === snap.activeSessionId)) {
      t._activeSessionId = snap.activeSessionId
    }
    return t
  }

  get name(): string {
    return this._name
  }
  get lifecycle(): TaskLifecycle {
    return this._lifecycle
  }
  get worktree(): WorktreeRef | undefined {
    return this._worktree
  }
  get activeSessionId(): SessionId | undefined {
    return this._activeSessionId
  }
  get position(): number {
    return this._position
  }

  rename(name: string): void {
    this._name = name
  }

  setPosition(position: number): void {
    this._position = position
  }

  /** Ordered snapshot of the task's sessions (by `order`). */
  sessions(): readonly Session[] {
    return [...this._sessions].sort((a, b) => a.order - b.order)
  }

  session(id: SessionId): Session | undefined {
    return this._sessions.find((s) => s.id === id)
  }

  // ── Lifecycle (§3.5) ────────────────────────────────────────────────────────

  private transition(to: TaskLifecycle): void {
    if (!canTransitionTask(this._lifecycle, to)) {
      throw new IllegalTransitionError(
        `task ${this.id}: illegal transition ${this._lifecycle} → ${to}`
      )
    }
    this._lifecycle = to
  }

  /** `None → Provisioning`: the create script is about to run (§3.5). */
  markProvisioning(): void {
    this.transition(TaskLifecycle.Provisioning)
  }

  /**
   * `Provisioning → Ready`: attach the validated worktree (I1). The worktree is
   * required to reach `Ready` and is immutable thereafter (I2).
   */
  markReady(worktree: WorktreeRef): void {
    this.transition(TaskLifecycle.Ready)
    this._worktree = worktree
  }

  /** `Provisioning → ProvisionFailed`: create script/validation failed (§3.5). */
  markProvisionFailed(): void {
    this.transition(TaskLifecycle.ProvisionFailed)
  }

  /** Enter `Deleting`: the strict teardown sequence begins (I3). */
  markDeleting(): void {
    this.transition(TaskLifecycle.Deleting)
  }

  /** `Deleting → Deleted` or discard a failed provision (§3.5). */
  markDeleted(): void {
    this.transition(TaskLifecycle.Deleted)
  }

  /** `Deleting → DeleteFailed`: delete script failed; retains metadata (I4). */
  markDeleteFailed(): void {
    this.transition(TaskLifecycle.DeleteFailed)
  }

  /** `Ready → Stale`: worktree missing on startup reconciliation (I14). */
  markStale(): void {
    this.transition(TaskLifecycle.Stale)
  }

  // ── Sessions (§3.2) ──────────────────────────────────────────────────────────

  /**
   * Add a session to this task. Enforces I7 (a session belongs to exactly one
   * task and cannot move between tasks): the session's `taskId` must match.
   */
  addSession(session: Session): void {
    if (session.taskId !== this.id) {
      throw new InvariantViolationError(
        `session ${session.id} belongs to task ${session.taskId}, not ${this.id} (I7)`
      )
    }
    if (this._sessions.some((s) => s.id === session.id)) {
      throw new InvariantViolationError(`session ${session.id} already in task ${this.id}`)
    }
    this._sessions.push(session)
    // First session becomes active by default (I10 holds trivially).
    if (this._activeSessionId === undefined) {
      this._activeSessionId = session.id
    }
  }

  /** Remove a session by id; fixes up the active pointer to preserve I10. */
  removeSession(id: SessionId): void {
    const idx = this._sessions.findIndex((s) => s.id === id)
    if (idx === -1) {
      return
    }
    this._sessions.splice(idx, 1)
    if (this._activeSessionId === id) {
      // Fall back to the first remaining session, or none (I10).
      const remaining = this.sessions()
      this._activeSessionId = remaining.length > 0 ? remaining[0].id : undefined
    }
  }

  /**
   * Move a session to a new index in the ordered tab list, renumbering `order`
   * on every session so it stays a dense 0..n-1 sequence.
   */
  reorderSession(id: SessionId, toIndex: number): void {
    const ordered = [...this.sessions()]
    const from = ordered.findIndex((s) => s.id === id)
    if (from === -1) {
      throw new InvariantViolationError(`session ${id} not in task ${this.id}`)
    }
    const clamped = Math.max(0, Math.min(toIndex, ordered.length - 1))
    const [moved] = ordered.splice(from, 1)
    ordered.splice(clamped, 0, moved)
    ordered.forEach((s, i) => s.setOrder(i))
  }

  /** Set the active session; must reference a session in this task (I10). */
  setActiveSession(id: SessionId | undefined): void {
    if (id !== undefined && !this._sessions.some((s) => s.id === id)) {
      throw new InvariantViolationError(`session ${id} not in task ${this.id} (I10)`)
    }
    this._activeSessionId = id
  }

  // ── Derived state (§3.4, I11) ────────────────────────────────────────────────

  /**
   * Derive the task's aggregate state from its sessions via the injected
   * aggregator (I11 — always derived, never assigned). In V1 every session
   * contributes `Unknown`, so this returns `TaskState.Unknown`.
   */
  deriveState(aggregator: TaskStateAggregator): TaskState {
    return aggregator.aggregate(this._sessions.map((s) => s.aggregationState()))
  }

  toSnapshot(aggregator: TaskStateAggregator): TaskSnapshot {
    return {
      id: this.id,
      name: this._name,
      worktree: this._worktree
        ? {
            path: this._worktree.path,
            branch: this._worktree.branch,
            baseRef: this._worktree.baseRef,
            managed: this._worktree.managed,
            provisionedBy: this._worktree.provisionedBy
          }
        : undefined,
      lifecycle: this._lifecycle,
      state: this.deriveState(aggregator),
      sessions: this.sessions().map((s) => s.toSnapshot()),
      activeSessionId: this._activeSessionId,
      position: this._position,
      createdAt: this.createdAt
    }
  }
}
