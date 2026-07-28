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

import { asTaskId, asSessionId, asTypeId, asWindowId } from '../../domain/ids'
import { SessionState, TaskState } from '../../domain/state'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import type { SessionConfig } from '../../domain/session-config'
import type { TaskSnapshot, SessionSnapshot } from '../../domain/snapshots'
import type { WindowRecord } from '../../ports/workspace-persistence'

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
  /** 1 = Octopus provisioned it (delete on removal); 0 = adopted, left on disk (§6.4). */
  managed: number
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
  /** V1.5 (§3.7): which window renders the session; NOT NULL DEFAULT 'main'. */
  window_id: string
  /**
   * Last-known cwd (§6.2), daemon-derived METADATA — NOT part of the session
   * definition. Written only by `SqliteStore.saveLastCwd` (never `sessionToRow`),
   * so it survives a definition upsert; read only by the fresh-spawn placement
   * fallback. Optional here because `sessionToRow` does not produce it. Nullable in
   * the DB (pre-v6 rows / never-persisted → null → worktree-root fallback).
   */
  last_cwd?: string | null
}

/** A `windows` row (V1.5, §3.7, §6.3). */
export interface WindowRow {
  id: string
  role: string
  x: number
  y: number
  width: number
  height: number
  created_at: number
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
    active_session_id: snap.activeSessionId ?? null,
    managed: snap.worktree.managed ? 1 : 0
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
    exited_at: snap.exitedAt ?? null,
    // Persist the assignment tag; `Session.toSnapshot` always emits a windowId (§3.7).
    window_id: snap.windowId ?? 'main'
  }
}

/** Serialize a window record for persistence (V1.5, §3.7). */
export function windowToRow(record: WindowRecord): WindowRow {
  return {
    id: record.id,
    role: record.role,
    x: record.bounds.x,
    y: record.bounds.y,
    width: record.bounds.width,
    height: record.bounds.height,
    created_at: record.createdAt
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
      managed: row.managed !== 0,
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
 * what the row recorded.
 *
 * On the in-process backend `Created` means "restore opens a fresh PTY". On the
 * durable daemon backend (§6.2) it means "no live session to attach *yet*" — the
 * decision is deferred to `startSessionRuntime`, which sets `ctx.resume` when the
 * daemon's live roster still holds this id and RE-ATTACHES instead of spawning.
 * Either way the row reloads identically here; the backend chooses spawn-vs-attach
 * at start time, so no lifecycle column and no mapper change is needed (§10).
 * `last_cwd` is intentionally NOT read into the snapshot — it is placement metadata
 * consumed directly by the fresh-spawn path, not part of the session definition.
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
    exitedAt: undefined,
    // Window assignment is persisted metadata (not live process state), so it
    // round-trips on restore — a restored session reappears in its window (I18).
    windowId: asWindowId(row.window_id)
  }
}

/** Reconstruct a window record from its row (V1.5, §3.7). */
export function rowToWindowRecord(row: WindowRow): WindowRecord {
  return {
    id: asWindowId(row.id),
    role: row.role === 'secondary' ? 'secondary' : 'main',
    bounds: { x: row.x, y: row.y, width: row.width, height: row.height },
    createdAt: row.created_at
  }
}
