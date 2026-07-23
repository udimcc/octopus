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

import type { TaskId, SessionId, TypeId } from './ids'
import type { SessionState, TaskState } from './state'
import type { TaskLifecycle, SessionLifecycle } from './lifecycle'
import type { SessionConfig } from './session-config'
import type { ScriptInvocationMeta } from './worktree-ref'

export interface WorktreeRefSnapshot {
  readonly path: string
  readonly branch?: string
  readonly baseRef?: string
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
}

export interface TaskSnapshot {
  readonly id: TaskId
  readonly name: string
  /** Present once the task is `Ready` (I1); absent while Provisioning/Failed. */
  readonly worktree?: WorktreeRefSnapshot
  readonly lifecycle: TaskLifecycle
  /** Always derived (I11); `Unknown` in V1. */
  readonly state: TaskState
  readonly sessions: readonly SessionSnapshot[]
  readonly activeSessionId?: SessionId
  readonly position: number
  readonly createdAt: number
}

export interface WorkspaceSnapshot {
  readonly tasks: readonly TaskSnapshot[]
  readonly activeTaskId?: TaskId
}
