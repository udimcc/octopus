/**
 * Persistence port for workspace metadata (DESIGN §6.3, §6.6). Implemented by
 * `SqliteStore` (better-sqlite3) in V1. Persists task/session DEFINITIONS and the
 * active-task pointer — never live PTY state (I13). All writes are synchronous
 * and sub-ms at this scale (§6.6); the single-writer command loop serializes them.
 *
 * The persistence-side representation is the domain's own snapshots, so this port
 * stays free of any storage-engine types.
 */

import type { TaskId, SessionId, WindowId, IssueId, GroupId } from '../domain/ids'
import type {
  WorkspaceSnapshot,
  TaskSnapshot,
  SessionSnapshot,
  IssueSnapshot,
  GroupSnapshot
} from '../domain/snapshots'

/**
 * A persisted OS window (V1.5, DESIGN §3.7, §6.3). Pixel geometry deliberately
 * lives here — in the persistence port + adapter + main — and never in the pure
 * domain. `role` distinguishes the single `main` window (which owns the progress
 * panel) from session-only `secondary` windows.
 */
export interface WindowRecord {
  readonly id: WindowId
  readonly role: 'main' | 'secondary'
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly createdAt: number
}

export interface WorkspacePersistence {
  /**
   * Load the full persisted workspace on startup (empty on first run) (§6.3).
   * Includes `issues` (I19, v8 schema).
   * Each task's split groups (§5.7) load with it, attached to `TaskSnapshot.groups`
   * — there is no separate group-load call.
   */
  load(): WorkspaceSnapshot

  /** Insert or update a task row (name/worktree/branch/repo_root/order/active-session). */
  upsertTask(task: TaskSnapshot): void
  /** Delete a task; sessions cascade via the FK (§6.3). Any bound issue's `task_id` is set to NULL. */
  deleteTask(taskId: TaskId): void

  /** Insert or update an issue row (I19, v8 schema). */
  upsertIssue(issue: IssueSnapshot): void
  /** Delete an issue row. The bound task, if any, is left untouched. */
  deleteIssue(id: IssueId): void

  /** Insert or update a session row (definition only). */
  upsertSession(session: SessionSnapshot): void
  deleteSession(sessionId: SessionId): void

  /**
   * Persist a session's captured terminal output (the §6.6 backend ring buffer),
   * replacing any prior snapshot. Replayed into a fresh PTY on restart. A raw
   * string, not a domain snapshot — captured output is metadata, not live state
   * (I13). The row cascades away when the session is deleted (close/task-delete).
   */
  saveScrollback(sessionId: SessionId, data: string): void
  /** Load a session's persisted scrollback, or undefined if none was stored. */
  loadScrollback(sessionId: SessionId): string | undefined

  /**
   * Persist a session's last-known working directory (§6.2). Like scrollback this
   * is daemon-derived METADATA, not live process state (I13): it is captured from
   * the daemon's `/proc/<pid>/cwd` on quit / roster refresh and used only to place
   * a FRESH spawn after a daemon-less restart (a re-attach carries the real cwd
   * with the live process, so this is the fallback). Nullable — absent means "use
   * the worktree root", exactly as today.
   */
  saveLastCwd(sessionId: SessionId, cwd: string): void
  /** Load a session's persisted last-known cwd, or undefined if none was stored. */
  loadLastCwd(sessionId: SessionId): string | undefined

  /** Persist the single active-task pointer into app_state (§6.3). */
  setActiveTask(taskId: TaskId | undefined): void

  /** Load every persisted window record on startup (V1.5, §3.7, §6.3). */
  loadWindows(): WindowRecord[]
  /** Insert or update a window row (id/role/bounds/created_at) (V1.5). */
  upsertWindow(record: WindowRecord): void
  /** Delete a window row (its sessions are reassigned by the use case, not cascaded) (V1.5). */
  deleteWindow(id: WindowId): void

  /**
   * Insert or update a task's split group (DESIGN §5.7): 2+ sessions of that
   * task, in one window, sharing a layout tree and a palette color. The tree
   * (leaves are member session ids) is persisted as an OPAQUE JSON blob — the
   * backend never interprets it, like window bounds being presentation-only.
   * `taskId` is the FK; `GroupSnapshot` itself carries no task reference (it
   * only ever travels inside `TaskSnapshot.groups`). The task's FK cascades, so
   * deleting the task drops its group rows with no explicit cleanup here.
   */
  upsertGroup(taskId: TaskId, group: GroupSnapshot): void
  /** Delete a group row (ungroup / dissolve-at-1 / member removed) (§5.7). */
  deleteGroup(groupId: GroupId): void

  /** Run `fn` inside a single transaction; used for the delete sequence (§6.6). */
  transaction<T>(fn: () => T): T

  /** `PRAGMA wal_checkpoint(TRUNCATE)` then close, on quit (§6.6, I13). */
  checkpointAndClose(): void
}
