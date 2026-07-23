/**
 * Persistence port for workspace metadata (DESIGN §6.3, §6.6). Implemented by
 * `SqliteStore` (better-sqlite3) in V1. Persists task/session DEFINITIONS and the
 * active-task pointer — never live PTY state (I13). All writes are synchronous
 * and sub-ms at this scale (§6.6); the single-writer command loop serializes them.
 *
 * The persistence-side representation is the domain's own snapshots, so this port
 * stays free of any storage-engine types.
 */

import type { TaskId, SessionId } from '../domain/ids'
import type { WorkspaceSnapshot, TaskSnapshot, SessionSnapshot } from '../domain/snapshots'

export interface WorkspacePersistence {
  /** Load the full persisted workspace on startup (empty on first run) (§6.3). */
  load(): WorkspaceSnapshot

  /** Insert or update a task row (name/worktree/branch/repo_root/order/active-session). */
  upsertTask(task: TaskSnapshot): void
  /** Delete a task; sessions cascade via the FK (§6.3). */
  deleteTask(taskId: TaskId): void

  /** Insert or update a session row (definition only). */
  upsertSession(session: SessionSnapshot): void
  deleteSession(sessionId: SessionId): void

  /** Persist the single active-task pointer into app_state (§6.3). */
  setActiveTask(taskId: TaskId | undefined): void

  /** Run `fn` inside a single transaction; used for the delete sequence (§6.6). */
  transaction<T>(fn: () => T): T

  /** `PRAGMA wal_checkpoint(TRUNCATE)` then close, on quit (§6.6, I13). */
  checkpointAndClose(): void
}
