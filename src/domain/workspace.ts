/**
 * `Workspace` — the app root aggregate (DESIGN §3.1, §3.2). Boundary for tasks
 * and the single active-task pointer: owns the "at most one active task" rule
 * (I9) and task-id uniqueness (I6). Tasks are ordered; cross-aggregate refs are
 * by id.
 *
 * **I19** (new, "Issues"): an `Issue` binds to at most one `Task`, and a `Task`
 * to at most one `Issue`. The binding is stored only on the issue
 * (`Issue.taskId`) — a task carries no reverse pointer, so `Workspace` is the
 * single place that enforces the 1:1 rule and resolves it in reverse via
 * `issueForTask`. `bindIssue` is also the only place the todo→in_progress
 * automation runs. `Issue.bindTo`/`clearBinding` are not meant to be called
 * from outside `Workspace`.
 */

import type { TaskId, IssueId } from './ids'
import { Task } from './task'
import { Issue, IssueStatus } from './issue'
import type { WorkspaceSnapshot } from './snapshots'
import { canonProjectPath } from './project-path'
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
  private _issues: Issue[]

  private constructor(config: WorkspaceConfig) {
    this._tasks = []
    this._config = config
    this._issues = []
  }

  /** Create an empty workspace. */
  static create(config: WorkspaceConfig): Workspace {
    return new Workspace(config)
  }

  /**
   * Reconstruct a workspace from persistence on startup (I15). Tasks are ordered
   * by position; the active-task pointer is restored only if it resolves (I9).
   * Issues (I19) are optional on the snapshot for pre-Issues fixtures, and any
   * binding to a task that no longer exists is dropped.
   */
  static hydrate(snap: WorkspaceSnapshot, config: WorkspaceConfig): Workspace {
    const ws = new Workspace(config)
    ws._tasks = snap.tasks.map((t) => Task.fromSnapshot(t)).sort((a, b) => a.position - b.position)
    if (snap.activeTaskId && ws._tasks.some((t) => t.id === snap.activeTaskId)) {
      ws._activeTaskId = snap.activeTaskId
    }
    ws._issues = (snap.issues ?? []).map((i) => Issue.fromSnapshot(i))
    for (const issue of ws._issues) {
      if (issue.taskId && !ws._tasks.some((t) => t.id === issue.taskId)) {
        issue.clearBinding()
      }
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

  /**
   * Remove a task; clears the active pointer if it referenced that task (I9),
   * and clears the binding of any issue bound to it (I19) — the issue's status
   * is left unchanged.
   */
  removeTask(id: TaskId): void {
    const idx = this._tasks.findIndex((t) => t.id === id)
    if (idx === -1) {
      return
    }
    this._tasks.splice(idx, 1)
    if (this._activeTaskId === id) {
      this._activeTaskId = undefined
    }
    this.issueForTask(id)?.clearBinding()
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

  // ── Issues (I19) ──────────────────────────────────────────────────────────

  issues(): readonly Issue[] {
    return [...this._issues]
  }

  issue(id: IssueId): Issue | undefined {
    return this._issues.find((i) => i.id === id)
  }

  /** The issue bound to `taskId`, if any — the reverse side of I19's binding. */
  issueForTask(taskId: TaskId): Issue | undefined {
    return this._issues.find((i) => i.taskId === taskId)
  }

  /** Add an issue; enforces IssueId uniqueness, mirroring `addTask`'s I6 check. */
  addIssue(issue: Issue): void {
    if (this._issues.some((i) => i.id === issue.id)) {
      throw new InvariantViolationError(`issue ${issue.id} already in workspace (I6)`)
    }
    this._issues.push(issue)
  }

  /** Remove an issue by id. A no-op if it is not present. */
  removeIssue(id: IssueId): void {
    const idx = this._issues.findIndex((i) => i.id === id)
    if (idx === -1) {
      return
    }
    this._issues.splice(idx, 1)
  }

  /**
   * Bind `issueId` to `taskId` (I19). The task must exist. Rejects a task
   * already bound to a *different* issue; if this issue was previously bound to
   * another task, that old binding is silently replaced. Moves the status
   * `Todo` → `InProgress` — the only automatic status change — but only when
   * the issue is currently `Todo`.
   */
  bindIssue(issueId: IssueId, taskId: TaskId): void {
    const issue = this.issue(issueId)
    if (!issue) {
      throw new InvariantViolationError(`issue ${issueId} not in workspace`)
    }
    if (!this.task(taskId)) {
      throw new InvariantViolationError(`task ${taskId} not in workspace (I19)`)
    }
    const boundElsewhere = this.issueForTask(taskId)
    if (boundElsewhere && boundElsewhere.id !== issueId) {
      throw new InvariantViolationError(
        `task ${taskId} already linked to issue ${boundElsewhere.id} (I19)`
      )
    }
    issue.bindTo(taskId)
    if (issue.status === IssueStatus.Todo) {
      issue.setStatus(IssueStatus.InProgress)
    }
  }

  /** Unbind an issue, if bound; leaves its status unchanged (I19). */
  unbindIssue(issueId: IssueId): void {
    this.issue(issueId)?.clearBinding()
  }

  /**
   * Restore a previously-captured binding/status directly, bypassing the 1:1
   * check and the todo→in_progress automation (I19) — the ONE place outside
   * `Issue` itself allowed to call `bindTo`/`clearBinding` on its behalf, used
   * only to roll back an in-memory mutation after a persistence failure, when
   * the state being restored already passed those checks once (the bind that
   * is being undone ran through `bindIssue` or `bindRequestedIssue`, both of
   * which validate before mutating). `priorTaskId: undefined` clears the
   * binding. A no-op if the issue is no longer in the workspace.
   */
  restoreIssueBinding(
    issueId: IssueId,
    priorTaskId: TaskId | undefined,
    priorStatus: IssueStatus
  ): void {
    const issue = this.issue(issueId)
    if (!issue) {
      return
    }
    if (priorTaskId !== undefined) {
      issue.bindTo(priorTaskId)
    } else {
      issue.clearBinding()
    }
    issue.setStatus(priorStatus)
  }

  /**
   * Clear the project on every issue whose project matches `projectPath`
   * (canonical comparison via `canonProjectPath`), e.g. when the project is
   * removed from settings. Returns the issues that changed.
   */
  clearIssueProject(projectPath: string): Issue[] {
    const target = canonProjectPath(projectPath)
    const changed: Issue[] = []
    for (const issue of this._issues) {
      if (issue.projectPath !== undefined && canonProjectPath(issue.projectPath) === target) {
        issue.setProject(undefined)
        changed.push(issue)
      }
    }
    return changed
  }

  toSnapshot(aggregator: Parameters<Task['toSnapshot']>[0]): WorkspaceSnapshot {
    return {
      tasks: this.tasks().map((t) => t.toSnapshot(aggregator)),
      activeTaskId: this._activeTaskId,
      issues: this.issues().map((i) => i.toSnapshot())
    }
  }
}
