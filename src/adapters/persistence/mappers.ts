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

import { asTaskId, asSessionId, asTypeId, asWindowId, asIssueId, asGroupId } from '../../domain/ids'
import { SessionState, TaskState } from '../../domain/state'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import { IssueStatus, parseIssueStatus, IssueSource, parseIssueSource } from '../../domain/issue'
import type { SessionConfig } from '../../domain/session-config'
import type { GroupTree } from '../../domain/group-tree'
import type { TaskId } from '../../domain/ids'
import type {
  TaskSnapshot,
  SessionSnapshot,
  IssueSnapshot,
  GroupSnapshot
} from '../../domain/snapshots'
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
  /** 1 = a "No Repo" task (§5.4): no worktree (`worktree = ''`), sessions open at home. */
  repo_less: number
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

/** An `issues` row (I19, v8 schema; `source`/`jira_key` added in v10, Jira import).
 * Nullable columns surface as `null` from better-sqlite3. */
export interface IssueRow {
  id: string
  name: string
  description: string
  project_path: string | null
  status: string
  /** UNIQUE, nullable (I19) — `null` means unbound; `ON DELETE SET NULL` on the task's deletion. */
  task_id: string | null
  created_at: number
  updated_at: number
  /** `'local'` or `'jira'` (CHECK-constrained); see `IssueSource`. */
  source: string
  /** UNIQUE (via `idx_issues_jira_key`), nullable — `null` means `source = 'local'`. */
  jira_key: string | null
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
 * A `session_groups` row (DESIGN §5.7). `layout` is JSON of the domain's
 * `GroupTree` (leaves are member session ids); `color` is the palette index
 * (`0..GROUP_COLOR_PALETTE_SIZE-1`).
 */
export interface GroupRow {
  id: string
  task_id: string
  layout: string
  color: number
}

/**
 * Serialize a task for persistence. Requires a worktree UNLESS the task is
 * `repoLess` (a "No Repo" task, §5.4): the `worktree` column is `NOT NULL`, and
 * per §6.3 only a Ready/Stale task is persistable — Provisioning/ProvisionFailed
 * tasks are transient and never written. A repo-less task has no worktree, so it
 * stores `worktree = ''` + `repo_less = 1` (the empty string is never read as a
 * path — `rowToTaskSnapshot` branches on `repo_less` first). Throwing here
 * enforces at the storage boundary that a worktree-less, non-repo-less (i.e.
 * transient) task is never written.
 */
export function taskToRow(snap: TaskSnapshot): TaskRow {
  // A repo-less task has no worktree by design: store the sentinel empty path +
  // repo_less = 1 (rowToTaskSnapshot branches on repo_less before reading it).
  if (snap.repoLess) {
    return {
      id: snap.id,
      name: snap.name,
      worktree: '',
      branch: null,
      base_ref: null,
      repo_root: null,
      created_at: snap.createdAt,
      position: snap.position,
      active_session_id: snap.activeSessionId ?? null,
      managed: 0,
      repo_less: 1
    }
  }
  const worktree = snap.worktree
  if (!worktree) {
    throw new Error(
      `cannot persist task ${snap.id}: no worktree (only provisioned or repo-less tasks persist, §6.3)`
    )
  }
  return {
    id: snap.id,
    name: snap.name,
    worktree: worktree.path,
    branch: worktree.branch ?? null,
    base_ref: worktree.baseRef ?? null,
    repo_root: worktree.provisionedBy.repoRoot || null,
    created_at: snap.createdAt,
    position: snap.position,
    active_session_id: snap.activeSessionId ?? null,
    managed: worktree.managed ? 1 : 0,
    repo_less: 0
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

/** Serialize an issue for persistence (I19, v8 schema; `source`/`jira_key` added in
 * v10, Jira import). `undefined` fields become `null`. */
export function issueToRow(snap: IssueSnapshot): IssueRow {
  return {
    id: snap.id,
    name: snap.name,
    description: snap.description,
    project_path: snap.projectPath ?? null,
    status: snap.status,
    task_id: snap.taskId ?? null,
    created_at: snap.createdAt,
    updated_at: snap.updatedAt,
    source: snap.source,
    jira_key: snap.jiraKey ?? null
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
 * Serialize a split group for persistence (DESIGN §5.7). `taskId` is passed in
 * rather than carried on `GroupSnapshot` itself — groups travel inside
 * `TaskSnapshot.groups`, so the row needs the FK supplied by the caller, the same
 * way `sessionToRow` reads `taskId` off the snapshot but a group snapshot has
 * none of its own.
 */
export function groupToRow(taskId: TaskId, group: GroupSnapshot): GroupRow {
  return {
    id: group.id,
    task_id: taskId,
    layout: JSON.stringify(group.tree),
    color: group.colorIndex
  }
}

/**
 * Reconstruct a group snapshot from its row (§5.7). The JSON parse is guarded
 * here, but a malformed row is NOT dropped (review round-2 fix) — it comes back
 * with its real `id` and a single-leaf `tree` marker that `Task.restoreGroups`
 * (via `validateGroupTree`, which rejects anything under 2 leaves) always
 * drops, same as before. Carrying the id through — rather than returning
 * `undefined` and losing it before it ever reaches a `TaskSnapshot` — matters
 * because `reconcileStaleGroups` (`application/reconcile.ts`) diffs the
 * pre-hydrate snapshot's group ids against each task's SURVIVING groups to find
 * stale `session_groups` rows to delete; an id that never makes it into the
 * snapshot can never be found stale and sits in the table forever. Everything
 * else (unknown or duplicate leaves, fewer than 2 members, members split across
 * windows, non-contiguous tab order) is cross-session validation that only
 * `Task.fromSnapshot` can do (DESIGN §5.7 "loading tolerates bad saved data"),
 * since this mapper has no visibility into the task's sessions.
 */
export function rowToGroupSnapshot(row: GroupRow): GroupSnapshot {
  let tree: GroupTree
  try {
    tree = JSON.parse(row.layout) as GroupTree
  } catch {
    // Invalid-layout marker: a lone leaf has only 1 member, so
    // `validateGroupTree`/`Task.restoreGroups` always rejects it (a group needs
    // 2+), just like any other corrupt saved group — but the id survives into
    // the snapshot for the stale-group sweep to find.
    tree = { kind: 'leaf', sessionId: asSessionId('') }
  }
  return {
    id: asGroupId(row.id),
    tree,
    colorIndex: row.color
  }
}

/**
 * Reconstruct a task snapshot from its row and its (ordered) session rows. The
 * task is `Ready` on reload (worktree present, or repo-less). The load-bearing
 * provenance — `baseRef` (source branch) and `repoRoot` (the task's repo dir) —
 * round-trips via the `base_ref`/`repo_root` columns, so a restarted app can still
 * delete the worktree via the SAME repo (§6.4). Provenance NOT persisted by §6.3
 * (the exact create command + args + provision time) is reconstructed as inert
 * placeholders — historical only, unused after restore.
 *
 * A repo-less task (§5.4) is detected by `repo_less` BEFORE reading `worktree`:
 * its `worktree` column is the sentinel `''` (never a path), so it reloads as a
 * `Ready` task with NO worktree and `repoLess: true` (its sessions re-open at home).
 *
 * `groupRows` (DESIGN §5.7) is optional and defaults to none, so callers that
 * predate groups (and existing tests) still compile; `Task.fromSnapshot` drops
 * any individually-invalid row rather than failing the load. `rowToGroupSnapshot`
 * never drops a row itself (not even on malformed JSON — see its own doc), so
 * every id reaches this snapshot and, through it, the stale-group sweep.
 */
export function rowToTaskSnapshot(
  row: TaskRow,
  sessionRows: readonly SessionRow[],
  groupRows: readonly GroupRow[] = []
): TaskSnapshot {
  const groups = groupRows.map(rowToGroupSnapshot)
  if (row.repo_less !== 0) {
    return {
      id: asTaskId(row.id),
      name: row.name,
      worktree: undefined,
      repoLess: true,
      lifecycle: TaskLifecycle.Ready,
      state: TaskState.Unknown,
      sessions: sessionRows.map(rowToSessionSnapshot),
      activeSessionId: row.active_session_id ? asSessionId(row.active_session_id) : undefined,
      position: row.position,
      createdAt: row.created_at,
      groups
    }
  }
  return {
    id: asTaskId(row.id),
    name: row.name,
    repoLess: false,
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
    createdAt: row.created_at,
    groups
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

/**
 * Reconstruct an issue snapshot from its row (I19, v8 schema; `source`/`jira_key`
 * added in v10, Jira import). `NULL` columns become `undefined`. `status` and
 * `source` go through `parseIssueStatus`/`parseIssueSource` rather than a bare
 * cast: a corrupt/pre-migration row (anything outside the enum's string values)
 * falls back to `Todo`/`Local` rather than smuggling an invalid value into the
 * domain layer, which never otherwise has to defend against one. Every pre-v10
 * row reads back `source = 'local'` (the column's `DEFAULT`) and `jira_key =
 * NULL` without this fallback ever triggering — it exists purely to defend
 * against a hand-edited or otherwise corrupted row.
 */
export function rowToIssueSnapshot(row: IssueRow): IssueSnapshot {
  return {
    id: asIssueId(row.id),
    name: row.name,
    description: row.description,
    projectPath: row.project_path ?? undefined,
    status: parseIssueStatus(row.status) ?? IssueStatus.Todo,
    taskId: row.task_id ? asTaskId(row.task_id) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: parseIssueSource(row.source) ?? IssueSource.Local,
    jiraKey: row.jira_key ?? undefined
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
