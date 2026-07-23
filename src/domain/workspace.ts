/**
 * `Workspace` — the app root aggregate (DESIGN §3.1, §3.2). Boundary for tasks
 * and the single active-task pointer: owns the "at most one active task" rule
 * (I9) and task-id uniqueness (I6). Tasks are ordered; cross-aggregate refs are
 * by id.
 */

import type { TaskId } from './ids'
import { Task } from './task'
import type { WorkspaceSnapshot } from './snapshots'
import { InvariantViolationError } from './errors'

/**
 * Workspace-level configuration (§3.1). The script paths and default shell/type
 * live in `settings.json` (§6.3); this is the domain's view of them, injected at
 * hydrate time. Kept minimal — settings are an application/adapter concern.
 */
export interface WorkspaceConfig {
  readonly defaultSessionTypeId: string
}

export class Workspace {
  private _tasks: Task[]
  private _activeTaskId?: TaskId
  private _config: WorkspaceConfig

  private constructor(config: WorkspaceConfig) {
    this._tasks = []
    this._config = config
  }

  /** Create an empty workspace. */
  static create(config: WorkspaceConfig): Workspace {
    return new Workspace(config)
  }

  /**
   * Reconstruct a workspace from persistence on startup (I15). Tasks are ordered
   * by position; the active-task pointer is restored only if it resolves (I9).
   */
  static hydrate(snap: WorkspaceSnapshot, config: WorkspaceConfig): Workspace {
    const ws = new Workspace(config)
    ws._tasks = snap.tasks.map((t) => Task.fromSnapshot(t)).sort((a, b) => a.position - b.position)
    if (snap.activeTaskId && ws._tasks.some((t) => t.id === snap.activeTaskId)) {
      ws._activeTaskId = snap.activeTaskId
    }
    return ws
  }

  get config(): WorkspaceConfig {
    return this._config
  }
  get activeTaskId(): TaskId | undefined {
    return this._activeTaskId
  }

  /** Ordered snapshot of tasks (by position). */
  tasks(): readonly Task[] {
    return [...this._tasks].sort((a, b) => a.position - b.position)
  }

  task(id: TaskId): Task | undefined {
    return this._tasks.find((t) => t.id === id)
  }

  /** Add a task; enforces TaskId uniqueness (I6). */
  addTask(task: Task): void {
    if (this._tasks.some((t) => t.id === task.id)) {
      throw new InvariantViolationError(`task ${task.id} already in workspace (I6)`)
    }
    this._tasks.push(task)
  }

  /** Remove a task; clears the active pointer if it referenced that task (I9). */
  removeTask(id: TaskId): void {
    const idx = this._tasks.findIndex((t) => t.id === id)
    if (idx === -1) {
      return
    }
    this._tasks.splice(idx, 1)
    if (this._activeTaskId === id) {
      this._activeTaskId = undefined
    }
  }

  /**
   * Move a task to a new index, renumbering `position` densely (0..n-1) so the
   * ordering stays canonical.
   */
  reorderTask(id: TaskId, toIndex: number): void {
    const ordered = [...this.tasks()]
    const from = ordered.findIndex((t) => t.id === id)
    if (from === -1) {
      throw new InvariantViolationError(`task ${id} not in workspace`)
    }
    const clamped = Math.max(0, Math.min(toIndex, ordered.length - 1))
    const [moved] = ordered.splice(from, 1)
    ordered.splice(clamped, 0, moved)
    ordered.forEach((t, i) => t.setPosition(i))
  }

  /**
   * Set the active task (≤1 active, I9). Switching tasks changes only visibility,
   * never any session's lifecycle (I9) — that is enforced by this method doing
   * nothing but move the pointer. `undefined` clears the active task.
   */
  setActiveTask(id: TaskId | undefined): void {
    if (id !== undefined && !this._tasks.some((t) => t.id === id)) {
      throw new InvariantViolationError(`task ${id} not in workspace (I9)`)
    }
    this._activeTaskId = id
  }

  updateConfig(patch: Partial<WorkspaceConfig>): void {
    this._config = { ...this._config, ...patch }
  }

  toSnapshot(aggregator: Parameters<Task['toSnapshot']>[0]): WorkspaceSnapshot {
    return {
      tasks: this.tasks().map((t) => t.toSnapshot(aggregator)),
      activeTaskId: this._activeTaskId
    }
  }
}
