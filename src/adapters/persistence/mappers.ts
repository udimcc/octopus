/**
 * Pure row ↔ snapshot mappers for the SQLite store (DESIGN §6.3). No
 * better-sqlite3 import — imports only domain types — so the whole module is
 * unit-testable under host Node.
 *
 * Two rules from §6.3/§7 shape the asymmetry between write and read:
 *
 *  - **Write persists definitions faithfully.** `taskToRow`/`sessionToRow`
 *    serialize the current snapshot, including the full `SessionConfig` as JSON
 *    (§3: configs are fully serializable; §10: adding a session type must need no
 *    schema change — a lone `shell` column can't hold a Jenkins config).
 *
 *  - **Read reconstructs a *fresh* definition (I13, §6.3 "open a fresh PTY").**
 *    Lifecycle is never a column, and live process state is never resurrected:
 *    a reloaded task is `Ready` (its worktree is `NOT NULL`; reconcile demotes to
 *    `Stale` if the path is gone — I14), and a reloaded session is a fresh
 *    `Created`/`Unknown` runtime with no exit time. The `state`/`exited_at`
 *    columns are written for record fidelity but intentionally NOT resurrected.
 */

import { asTaskId, asSessionId, asTypeId } from '../../domain/ids'
import { SessionState, TaskState } from '../../domain/state'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import type { SessionConfig } from '../../domain/session-config'
import type { TaskSnapshot, SessionSnapshot } from '../../domain/snapshots'

/** A `tasks` row (§6.3). Nullable columns surface as `null` from better-sqlite3. */
export interface TaskRow {
  id: string
  name: string
  worktree: string
  branch: string | null
  base_ref: string | null
  repo_root: string | null
  created_at: number
  position: number
  active_session_id: string | null
}

/** A `sessions` row (§6.3, plus the `config` JSON column). */
export interface SessionRow {
  id: string
  task_id: string
  type: string
  label: string
  shell: string | null
  config: string
  position: number
  state: string
  created_at: number
  exited_at: number | null
}

/**
 * Serialize a task for persistence. Requires a worktree: the `worktree` column
 * is `NOT NULL`, and per §6.3 only a provisioned task (Ready/Stale) is
 * persistable — Provisioning/ProvisionFailed tasks are transient and never
 * written. Throwing here enforces that at the storage boundary.
 */
export function taskToRow(snap: TaskSnapshot): TaskRow {
  if (!snap.worktree) {
    throw new Error(
      `cannot persist task ${snap.id}: no worktree (only provisioned tasks persist, §6.3)`
    )
  }
  return {
    id: snap.id,
    name: snap.name,
    worktree: snap.worktree.path,
    branch: snap.worktree.branch ?? null,
    base_ref: snap.worktree.baseRef ?? null,
    repo_root: snap.worktree.provisionedBy.repoRoot || null,
    created_at: snap.createdAt,
    position: snap.position,
    active_session_id: snap.activeSessionId ?? null
  }
}

/** Serialize a session definition for persistence (config as JSON, §6.3/§10). */
export function sessionToRow(snap: SessionSnapshot): SessionRow {
  return {
    id: snap.id,
    task_id: snap.taskId,
    type: snap.typeId,
    label: snap.title,
    // Denormalized convenience column (§6.3, human-editable); the authoritative
    // shell on reload comes from the parsed `config` JSON below.
    shell: snap.config.kind === 'terminal' ? (snap.config.shell ?? null) : null,
    config: JSON.stringify(snap.config),
    position: snap.order,
    state: snap.state,
    created_at: snap.createdAt,
    exited_at: snap.exitedAt ?? null
  }
}

/**
 * Reconstruct a task snapshot from its row and its (ordered) session rows. The
 * task is `Ready` on reload (worktree present). The load-bearing provenance —
 * `baseRef` (source branch) and `repoRoot` (the task's repo dir) — round-trips
 * via the `base_ref`/`repo_root` columns, so a restarted app can still delete the
 * worktree via the SAME repo (§6.4). Provenance NOT persisted by §6.3 (the exact
 * create command + args + provision time) is reconstructed as inert placeholders —
 * historical only, unused after restore.
 */
export function rowToTaskSnapshot(row: TaskRow, sessionRows: readonly SessionRow[]): TaskSnapshot {
  return {
    id: asTaskId(row.id),
    name: row.name,
    worktree: {
      path: row.worktree,
      branch: row.branch ?? undefined,
      baseRef: row.base_ref ?? undefined,
      provisionedBy: {
        script: '',
        args: [],
        repoRoot: row.repo_root ?? '',
        provisionedAt: row.created_at
      }
    },
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: sessionRows.map(rowToSessionSnapshot),
    activeSessionId: row.active_session_id ? asSessionId(row.active_session_id) : undefined,
    position: row.position,
    createdAt: row.created_at
  }
}

/**
 * Reconstruct a session snapshot as a fresh definition (I13, §6.3). Lifecycle
 * resets to `Created`, state to `Unknown`, and exit time is cleared regardless of
 * what the row recorded — restore opens a fresh PTY, never resurrects the dead
 * process.
 */
export function rowToSessionSnapshot(row: SessionRow): SessionSnapshot {
  return {
    id: asSessionId(row.id),
    taskId: asTaskId(row.task_id),
    typeId: asTypeId(row.type),
    title: row.label,
    config: JSON.parse(row.config) as SessionConfig,
    lifecycle: SessionLifecycle.Created,
    state: SessionState.Unknown,
    order: row.position,
    createdAt: row.created_at,
    exitedAt: undefined
  }
}
