/**
 * Pure, serializable snapshots of the aggregates (DESIGN §3). These are the
 * domain's own read-model: `toSnapshot()` on each entity produces one, and
 * persistence + the application query layer consume them.
 *
 * They are structurally aligned with the renderer-facing DTOs in `src/shared`,
 * but the domain must NOT import `shared` (dependency rule). The application
 * layer maps snapshot → DTO at the boundary; keeping the two in step is a
 * deliberate, tested seam rather than a shared import.
 */

import type { TaskId, SessionId, TypeId, WindowId, IssueId } from './ids'
import type { SessionState, TaskState } from './state'
import type { TaskLifecycle, SessionLifecycle } from './lifecycle'
import type { SessionConfig } from './session-config'
import type { ScriptInvocationMeta } from './worktree-ref'
import type { IssueStatus } from './issue'

export interface WorktreeRefSnapshot {
  readonly path: string
  readonly branch?: string
  readonly baseRef?: string
  /** true = Octopus provisioned it (delete on removal); false = adopted, left on disk (§6.4). */
  readonly managed: boolean
  readonly provisionedBy: ScriptInvocationMeta
}

export interface SessionSnapshot {
  readonly id: SessionId
  readonly taskId: TaskId
  readonly typeId: TypeId
  readonly title: string
  readonly config: SessionConfig
  readonly lifecycle: SessionLifecycle
  /** V2+; always `Unknown` in V1. */
  readonly state: SessionState
  readonly order: number
  readonly createdAt: number
  readonly exitedAt?: number
  /**
   * Which window renders this session (V1.5, DESIGN §3.7). Opaque tag; drives no
   * invariant or lifecycle. Optional on read so pre-V1.5 snapshots hydrate as
   * `MAIN_WINDOW_ID` (see `Session.fromSnapshot`).
   */
  readonly windowId?: WindowId
}

export interface TaskSnapshot {
  readonly id: TaskId
  readonly name: string
  /**
   * The worktree, present once the task is `Ready` — UNLESS the task is `repoLess`
   * (I1'). Absent while Provisioning/Failed, and always absent for a repo-less task.
   */
  readonly worktree?: WorktreeRefSnapshot
  /**
   * A "No Repo" task (§5.4): permanently `Ready` with NO worktree, its sessions
   * open at the home dir. Distinguishes an intentional repo-less task from the
   * transient worktree-less Provisioning state. Optional so pre-feature snapshots
   * hydrate as `false`.
   */
  readonly repoLess?: boolean
  readonly lifecycle: TaskLifecycle
  /** Always derived (I11); `Unknown` in V1. */
  readonly state: TaskState
  readonly sessions: readonly SessionSnapshot[]
  readonly activeSessionId?: SessionId
  readonly position: number
  readonly createdAt: number
}

export interface IssueSnapshot {
  readonly id: IssueId
  readonly name: string
  readonly description: string
  /** One of the configured Projects' paths, or absent ("Issues", §13.1). */
  readonly projectPath?: string
  readonly status: IssueStatus
  /**
   * The task this issue is bound to, if any. The binding is stored only here
   * (I19) — a task never carries a reverse pointer.
   */
  readonly taskId?: TaskId
  readonly createdAt: number
  readonly updatedAt: number
}

export interface WorkspaceSnapshot {
  readonly tasks: readonly TaskSnapshot[]
  readonly activeTaskId?: TaskId
  /**
   * Optional so pre-Issues snapshot fixtures still compile; `Workspace.hydrate`
   * treats an absent array as empty (I19).
   */
  readonly issues?: readonly IssueSnapshot[]
}
