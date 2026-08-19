/**
 * `WorkspacePersistence` over SQLite (DESIGN §6.3, §6.6). Implemented against the
 * narrow {@link SqliteDb} interface, NOT the better-sqlite3 module directly, so
 * this file loads under host Node for unit tests with a fake db; the real
 * Electron-ABI binary is wired in only at `open-database.ts` / the composition
 * root. All writes are synchronous and sub-ms at this scale; the single-writer
 * command loop serializes them (§6.6), so no locking here.
 *
 * Row shaping and the fresh-on-reload semantics (I13) live in the pure
 * `mappers.ts`; this class is just prepared statements + the schema bootstrap.
 */

import type { TaskId, SessionId, WindowId } from '../../domain/ids'
import type { WorkspaceSnapshot, TaskSnapshot, SessionSnapshot } from '../../domain/snapshots'
import type { WorkspacePersistence, WindowRecord } from '../../ports/workspace-persistence'
import type { SqliteDb } from './sqlite-db'
import {
  SCHEMA_STATEMENTS,
  CONNECTION_PRAGMAS,
  SCHEMA_VERSION,
  MIGRATIONS,
  ACTIVE_TASK_KEY
} from './schema'
import {
  taskToRow,
  sessionToRow,
  windowToRow,
  rowToTaskSnapshot,
  rowToWindowRecord,
  type TaskRow,
  type SessionRow,
  type WindowRow
} from './mappers'
import { IncompatibleDbError } from './errors'

export class SqliteStore implements WorkspacePersistence {
  private readonly db: SqliteDb

  private constructor(db: SqliteDb) {
    this.db = db
  }

  /**
   * Apply connection pragmas, create the schema, run any pending migrations, then
   * wrap the db. Idempotent (`IF NOT EXISTS`), so it is safe on every launch.
   *
   * Ordering matters: `CREATE TABLE IF NOT EXISTS` bootstraps a *fresh* DB at the
   * current schema (with `base_ref`), while `runMigrations` upgrades an *existing*
   * older DB whose `tasks` table predates the column — the guard on `user_version`
   * makes the `ALTER` a no-op for a fresh DB (already at SCHEMA_VERSION) and for an
   * already-migrated one, so exactly one of the two paths adds the column (§10).
   *
   * `beforeMigrate` (optional) is invoked EXACTLY when a pre-existing older DB is
   * about to be upgraded — after the future-DB guard and connection pragmas, but
   * before any `CREATE`/`ALTER` runs. `open-database.ts` uses it to snapshot the
   * live DB file (the pre-migration backup) without pulling `node:fs` into this
   * host-Node-testable module. It is NOT called for a fresh DB or an
   * already-current one (nothing to migrate, nothing to back up).
   */
  static create(db: SqliteDb, beforeMigrate?: (fromVersion: number) => void): SqliteStore {
    for (const pragma of CONNECTION_PRAGMAS) {
      db.exec(pragma)
    }

    // Snapshot BEFORE creating tables: a fresh DB has no `tasks` table yet, an
    // upgraded DB does. This is what tells a first launch (schema already current
    // after the CREATE below) apart from an old DB that needs an `ALTER`.
    const preExisting = tableExists(db, 'tasks')
    const fromVersion = readUserVersion(db)

    // Refuse a DB written by a NEWER Octopus (rollback with the shared data dir,
    // §6.3): the forward-only migrations cannot downgrade it, and the unconditional
    // `user_version` stamp below would otherwise SILENTLY lower the recorded version
    // — leaving the DB physically at the newer schema but labelled older, so the
    // next upgrade re-runs an already-applied migration and dies ("duplicate
    // column"). Throw before touching the DB so the file is left exactly as-is.
    if (preExisting && fromVersion > SCHEMA_VERSION) {
      throw new IncompatibleDbError(fromVersion, SCHEMA_VERSION)
    }

    // Back up the file before an actual upgrade (older → current). Guard mirrors the
    // `runMigrations` condition below so a fresh/already-current DB is never copied.
    if (preExisting && fromVersion < SCHEMA_VERSION) {
      beforeMigrate?.(fromVersion)
    }

    for (const stmt of SCHEMA_STATEMENTS) {
      db.exec(stmt)
    }

    // Only a pre-existing, older DB runs migrations; a fresh DB was just created
    // at SCHEMA_VERSION by the statements above (its `tasks` already has base_ref,
    // so the v2 ALTER must be skipped or it would fail with "duplicate column").
    if (preExisting) {
      runMigrations(db, fromVersion)
    }

    // Safe to stamp: the guard above rejected `fromVersion > SCHEMA_VERSION`, so this
    // only ever raises (fresh/older DB) or holds (already-current) the version —
    // never lowers it. Keep the guard and this line in lockstep; removing the guard
    // would reintroduce the silent downgrade described above.
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
    return new SqliteStore(db)
  }

  load(): WorkspaceSnapshot {
    const taskRows = this.db.prepare('SELECT * FROM tasks ORDER BY position ASC').all() as TaskRow[]
    const sessionRows = this.db
      .prepare('SELECT * FROM sessions ORDER BY task_id ASC, position ASC')
      .all() as SessionRow[]

    // Bucket sessions by task once, preserving the position-ordered scan.
    const byTask = new Map<string, SessionRow[]>()
    for (const row of sessionRows) {
      const bucket = byTask.get(row.task_id)
      if (bucket) {
        bucket.push(row)
      } else {
        byTask.set(row.task_id, [row])
      }
    }

    const tasks = taskRows.map((row) => rowToTaskSnapshot(row, byTask.get(row.id) ?? []))
    const activeTaskId = this.readActiveTask()
    // Guard the active pointer against a task that no longer exists (I9); hydrate
    // enforces this too, but keeping the snapshot clean avoids surprises.
    const activeExists = activeTaskId !== undefined && tasks.some((t) => t.id === activeTaskId)
    return { tasks, activeTaskId: activeExists ? activeTaskId : undefined }
  }

  upsertTask(task: TaskSnapshot): void {
    const row = taskToRow(task)
    this.db
      .prepare(
        `INSERT INTO tasks (id, name, worktree, branch, base_ref, repo_root, created_at, position, active_session_id, managed, repo_less)
         VALUES (@id, @name, @worktree, @branch, @base_ref, @repo_root, @created_at, @position, @active_session_id, @managed, @repo_less)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           worktree = excluded.worktree,
           branch = excluded.branch,
           base_ref = excluded.base_ref,
           repo_root = excluded.repo_root,
           position = excluded.position,
           active_session_id = excluded.active_session_id,
           managed = excluded.managed,
           repo_less = excluded.repo_less`
      )
      .run(row)
  }

  deleteTask(taskId: TaskId): void {
    // Sessions cascade via the FK (§6.3); foreign_keys pragma is ON per connection.
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
  }

  upsertSession(session: SessionSnapshot): void {
    const row = sessionToRow(session)
    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, type, label, shell, config, position, state, created_at, exited_at, window_id)
         VALUES (@id, @task_id, @type, @label, @shell, @config, @position, @state, @created_at, @exited_at, @window_id)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           shell = excluded.shell,
           config = excluded.config,
           position = excluded.position,
           state = excluded.state,
           exited_at = excluded.exited_at,
           window_id = excluded.window_id`
      )
      .run(row)
  }

  deleteSession(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }

  saveScrollback(sessionId: SessionId, data: string): void {
    this.db
      .prepare(
        `INSERT INTO session_scrollback (session_id, data) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`
      )
      .run(sessionId, data)
  }

  loadScrollback(sessionId: SessionId): string | undefined {
    const row = this.db
      .prepare('SELECT data FROM session_scrollback WHERE session_id = ?')
      .get(sessionId) as { data: string } | undefined
    return row ? row.data : undefined
  }

  saveLastCwd(sessionId: SessionId, cwd: string): void {
    // A column on `sessions` (not a side table): `upsertSession` never lists it, so
    // a session-definition upsert preserves the cwd, and this UPDATE is the only
    // writer. No-op if the session row is gone (closed/deleted) — nothing to place.
    this.db.prepare('UPDATE sessions SET last_cwd = ? WHERE id = ?').run(cwd, sessionId)
  }

  loadLastCwd(sessionId: SessionId): string | undefined {
    const row = this.db
      .prepare('SELECT last_cwd FROM sessions WHERE id = ?')
      .get(sessionId) as { last_cwd: string | null } | undefined
    return row && row.last_cwd !== null ? row.last_cwd : undefined
  }

  setActiveTask(taskId: TaskId | undefined): void {
    if (taskId === undefined) {
      this.db.prepare('DELETE FROM app_state WHERE key = ?').run(ACTIVE_TASK_KEY)
      return
    }
    this.db
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(ACTIVE_TASK_KEY, taskId)
  }

  loadWindows(): WindowRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM windows ORDER BY created_at ASC')
      .all() as WindowRow[]
    return rows.map(rowToWindowRecord)
  }

  upsertWindow(record: WindowRecord): void {
    const row = windowToRow(record)
    this.db
      .prepare(
        `INSERT INTO windows (id, role, x, y, width, height, created_at)
         VALUES (@id, @role, @x, @y, @width, @height, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           role = excluded.role,
           x = excluded.x,
           y = excluded.y,
           width = excluded.width,
           height = excluded.height`
      )
      .run(row)
  }

  deleteWindow(id: WindowId): void {
    // Sessions are NOT cascaded: the close-window use case reassigns them to the
    // main window (or closes them) BEFORE this runs (§6.7), so no orphan rows.
    this.db.prepare('DELETE FROM windows WHERE id = ?').run(id)
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  checkpointAndClose(): void {
    // Fold the WAL back into the main db file so a copy of octopus.db is complete
    // (§6.6, I13), then close.
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.close()
  }

  private readActiveTask(): TaskId | undefined {
    const row = this.db
      .prepare('SELECT value FROM app_state WHERE key = ?')
      .get(ACTIVE_TASK_KEY) as { value: string } | undefined
    return row ? (row.value as TaskId) : undefined
  }
}

/** Read `PRAGMA user_version` (0 on a brand-new DB). */
function readUserVersion(db: SqliteDb): number {
  const result = db.pragma('user_version')
  // better-sqlite3 returns `[{ user_version: N }]` for a value pragma; be tolerant.
  if (Array.isArray(result) && result.length > 0) {
    const row = result[0] as { user_version?: number }
    return typeof row.user_version === 'number' ? row.user_version : 0
  }
  if (typeof result === 'number') {
    return result
  }
  return 0
}

/** True iff a table with this name exists (used to spot a pre-existing DB). */
function tableExists(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined
  return row !== undefined
}

/**
 * Apply every migration whose `toVersion` exceeds the DB's current version, in
 * order. Called only for a pre-existing DB (a fresh one is already at
 * SCHEMA_VERSION), so the `fromVersion` guard skips migrations an upgraded DB has
 * already run — the v2 `ALTER` therefore fires exactly once per old DB (§10).
 */
function runMigrations(db: SqliteDb, fromVersion: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.toVersion > fromVersion) {
      for (const stmt of migration.statements) {
        db.exec(stmt)
      }
    }
  }
}
