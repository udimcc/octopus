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

import type { TaskId, SessionId, WindowId, IssueId, GroupId } from '../../domain/ids'
import type {
  WorkspaceSnapshot,
  TaskSnapshot,
  SessionSnapshot,
  IssueSnapshot,
  GroupSnapshot
} from '../../domain/snapshots'
import type {
  WorkspacePersistence,
  WindowRecord,
  PersistedScrollback
} from '../../ports/workspace-persistence'
import { SCROLLBACK_MAX_BYTES, tailBytes } from '../../shared/node/ring-buffer'
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
  issueToRow,
  groupToRow,
  rowToTaskSnapshot,
  rowToWindowRecord,
  rowToIssueSnapshot,
  type TaskRow,
  type SessionRow,
  type WindowRow,
  type IssueRow,
  type GroupRow
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

    // Schema, migrations, index and version stamp run as ONE transaction (SQLite DDL
    // is transactional): a crash mid-upgrade — e.g. between the two v10 `ALTER`s —
    // rolls back to the old shape and old `user_version`, so the next open simply
    // retries instead of failing forever on a half-applied migration.
    db.transaction(() => {
      for (const stmt of SCHEMA_STATEMENTS) {
        db.exec(stmt)
      }

      // Only a pre-existing, older DB runs migrations; a fresh DB was just created
      // at SCHEMA_VERSION by the statements above (its `tasks` already has base_ref,
      // so the v2 ALTER must be skipped or it would fail with "duplicate column").
      if (preExisting) {
        runMigrations(db, fromVersion)
      }

      // Schema v10 (Jira import): the UNIQUE index on `issues.jira_key`. Deliberately
      // run here — once, unconditionally, after BOTH the bootstrap statements above
      // and any migrations — rather than living in SCHEMA_STATEMENTS or the v10
      // migration's own statement list; see the long comments at
      // `idx_issues_jira_key` (schema.ts) and on the v10 `Migration` entry for why
      // either of those would break on some upgrade path. By this point every DB
      // shape (fresh, v7, v8, v9, already-v10) has the `jira_key` column, so this
      // single `IF NOT EXISTS` call is unconditionally safe. v12 (Blocked status)
      // rebuilds `issues` (DROP + RENAME), which drops this index with the old
      // table — so on a v11 -> v12 upgrade this call is what re-creates it.
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_jira_key ON issues(jira_key)')

      // Safe to stamp: the guard above rejected `fromVersion > SCHEMA_VERSION`, so this
      // only ever raises (fresh/older DB) or holds (already-current) the version —
      // never lowers it. Keep the guard and this line in lockstep; removing the guard
      // would reintroduce the silent downgrade described above.
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
    return new SqliteStore(db)
  }

  load(): WorkspaceSnapshot {
    const taskRows = this.db.prepare('SELECT * FROM tasks ORDER BY position ASC').all() as TaskRow[]
    // `created_at` is a tiebreak for a `position` collision (review C1 — a stale
    // DB written before the tail-placement fix could have one): without it the
    // scan order for tied rows is unspecified, so which session a group's
    // contiguity check sees first could vary between loads.
    const sessionRows = this.db
      .prepare('SELECT * FROM sessions ORDER BY task_id ASC, position ASC, created_at ASC')
      .all() as SessionRow[]
    // Groups travel inside the task DTO (§5.7), not a separate channel, so they
    // load with their task here, same as sessions. `session_groups` has no
    // `position` column (groups aren't ordered among themselves — only their
    // MEMBER sessions are), so `rowid` is the tiebreak (review I1): without an
    // ORDER BY at all, which of two conflicting groups (e.g. a duplicate-leaf
    // race) "wins" first-use in `Task.restoreGroups` was scan-order-dependent —
    // unspecified by SQLite and not reproducible across reloads.
    const groupRows = this.db
      .prepare('SELECT * FROM session_groups ORDER BY task_id ASC, rowid ASC')
      .all() as GroupRow[]

    // Bucket sessions and groups by task once, preserving the position-ordered scan.
    const byTask = new Map<string, SessionRow[]>()
    for (const row of sessionRows) {
      const bucket = byTask.get(row.task_id)
      if (bucket) {
        bucket.push(row)
      } else {
        byTask.set(row.task_id, [row])
      }
    }
    const groupsByTask = new Map<string, GroupRow[]>()
    for (const row of groupRows) {
      const bucket = groupsByTask.get(row.task_id)
      if (bucket) {
        bucket.push(row)
      } else {
        groupsByTask.set(row.task_id, [row])
      }
    }

    const tasks = taskRows.map((row) =>
      rowToTaskSnapshot(row, byTask.get(row.id) ?? [], groupsByTask.get(row.id) ?? [])
    )
    const activeTaskId = this.readActiveTask()
    // Guard the active pointer against a task that no longer exists (I9); hydrate
    // enforces this too, but keeping the snapshot clean avoids surprises.
    const activeExists = activeTaskId !== undefined && tasks.some((t) => t.id === activeTaskId)

    // Newest first (I19), with `id` as a tiebreaker for issues created in the
    // same millisecond so `load`'s order is deterministic. This is only a
    // starting order, not a guarantee: the renderer re-sorts for display, and
    // `createIssue` appends new issues to in-memory order rather than
    // reinserting at the front, so the live `Workspace`'s order can already
    // diverge from created-desc before the next `load`.
    const issueRows = this.db
      .prepare('SELECT * FROM issues ORDER BY created_at DESC, id')
      .all() as IssueRow[]
    const issues = issueRows.map(rowToIssueSnapshot)

    return { tasks, activeTaskId: activeExists ? activeTaskId : undefined, issues }
  }

  // `ON CONFLICT(id) DO UPDATE`, deliberately NOT `INSERT OR REPLACE` (I19): REPLACE
  // deletes-then-reinserts the row, which would fire `issues.task_id`'s
  // `ON DELETE SET NULL` and silently unbind any issue connected to this task on
  // every routine save. DO UPDATE mutates the row in place, so the FK never sees a
  // delete. The same caution applies beyond this one statement: a future migration
  // that rebuilds the `tasks` table (e.g. `ALTER TABLE` via copy-and-swap, which
  // SQLite needs for operations it can't do in place) deletes every row as part of
  // the rebuild and would fire this exact trigger for every bound issue — any such
  // migration must re-point `issues.task_id` (or otherwise preserve the bindings)
  // as part of the same migration, not rely on this file's routine-save path.
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
    // Any issue bound to this task has its `task_id` set to NULL by the same FK
    // (I19) — the issue row itself is left untouched.
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
  }

  // `ON CONFLICT(id) DO UPDATE`, same reasoning as `upsertTask` above: this issue
  // row's own `id` is never the FK target, but mutating in place rather than
  // delete+reinsert keeps the pattern consistent and avoids any accidental
  // `task_id` churn on an unrelated column update.
  //
  // `source` and `jira_key` (v10, Jira import) are bound on INSERT but deliberately
  // left OUT of the `DO UPDATE SET` list: both are immutable once an issue is
  // created (`Issue` exposes no setter for either — see domain/issue.ts), so a
  // routine re-save must never let them drift even if a future caller's snapshot
  // somehow carried a different value.
  upsertIssue(issue: IssueSnapshot): void {
    const row = issueToRow(issue)
    this.db
      .prepare(
        `INSERT INTO issues (id, name, description, project_path, status, task_id, created_at, updated_at, source, jira_key, blocked_reasons)
         VALUES (@id, @name, @description, @project_path, @status, @task_id, @created_at, @updated_at, @source, @jira_key, @blocked_reasons)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           project_path = excluded.project_path,
           status = excluded.status,
           task_id = excluded.task_id,
           updated_at = excluded.updated_at,
           blocked_reasons = excluded.blocked_reasons`
      )
      .run(row)
  }

  deleteIssue(id: IssueId): void {
    // The bound task, if any, is left untouched — the FK is on `issues.task_id`,
    // not the other way around, so deleting an issue never cascades to a task.
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
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

  saveScrollback(sessionId: SessionId, live: string): void {
    // Writes only the live part; `history` is set by rotation alone. Guarded on the
    // session row existing so a flush racing a close/task-delete is a no-op instead
    // of a foreign-key error. A new row starts with an empty (not legacy NULL) history.
    this.db
      .prepare(
        `INSERT INTO session_scrollback (session_id, data, history)
         SELECT ?, ?, '' WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)
         ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`
      )
      .run(sessionId, live, sessionId)
  }

  loadScrollback(sessionId: SessionId): PersistedScrollback | undefined {
    const row = this.db
      .prepare('SELECT data, history FROM session_scrollback WHERE session_id = ?')
      .get(sessionId) as { data: string; history: string | null } | undefined
    return row ? { history: row.history ?? null, live: row.data } : undefined
  }

  rotateScrollback(sessionId: SessionId): string {
    return this.db.transaction(() => {
      const row = this.loadScrollback(sessionId)
      if (!row) {
        return ''
      }
      if (row.live === '' && row.history !== null) {
        return row.history // nothing to fold (e.g. a StartFailed tab's next boot)
      }
      const history = tailBytes((row.history ?? '') + row.live, SCROLLBACK_MAX_BYTES)
      this.db
        .prepare(`UPDATE session_scrollback SET history = ?, data = '' WHERE session_id = ?`)
        .run(history, sessionId)
      return history
    })()
  }

  setScrollbackHistory(sessionId: SessionId, history: string): void {
    this.db
      .prepare('UPDATE session_scrollback SET history = ? WHERE session_id = ?')
      .run(history, sessionId)
  }

  saveLastCwd(sessionId: SessionId, cwd: string): void {
    // A column on `sessions` (not a side table): `upsertSession` never lists it, so
    // a session-definition upsert preserves the cwd, and this UPDATE is the only
    // writer. No-op if the session row is gone (closed/deleted) — nothing to place.
    this.db.prepare('UPDATE sessions SET last_cwd = ? WHERE id = ?').run(cwd, sessionId)
  }

  loadLastCwd(sessionId: SessionId): string | undefined {
    const row = this.db.prepare('SELECT last_cwd FROM sessions WHERE id = ?').get(sessionId) as
      { last_cwd: string | null } | undefined
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
        `INSERT INTO windows (id, role, x, y, width, height, created_at, task_id, parent_window_id)
         VALUES (@id, @role, @x, @y, @width, @height, @created_at, @task_id, @parent_window_id)
         ON CONFLICT(id) DO UPDATE SET
           role = excluded.role,
           x = excluded.x,
           y = excluded.y,
           width = excluded.width,
           height = excluded.height,
           task_id = excluded.task_id,
           parent_window_id = excluded.parent_window_id`
      )
      .run(row)
  }

  deleteWindow(id: WindowId): void {
    // Sessions are NOT cascaded: the close-window use case reassigns them to the
    // main window (or closes them) BEFORE this runs (§6.7), so no orphan rows.
    this.db.prepare('DELETE FROM windows WHERE id = ?').run(id)
  }

  upsertGroup(taskId: TaskId, group: GroupSnapshot): void {
    const row = groupToRow(taskId, group)
    this.db
      .prepare(
        `INSERT INTO session_groups (id, task_id, layout, color)
         VALUES (@id, @task_id, @layout, @color)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           layout = excluded.layout,
           color = excluded.color`
      )
      .run(row)
  }

  deleteGroup(groupId: GroupId): void {
    this.db.prepare('DELETE FROM session_groups WHERE id = ?').run(groupId)
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
 * True iff `table` currently has a column named `column`, via `PRAGMA
 * table_info` (v10, Jira import — backs `Migration.unlessColumnExists`). Returns
 * false for a non-array pragma result (e.g. a table that doesn't exist at all),
 * same tolerance as `readUserVersion` below for better-sqlite3's pragma shape.
 */
function columnExists(db: SqliteDb, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`)
  if (!Array.isArray(rows)) {
    return false
  }
  return rows.some((row) => (row as { name?: unknown }).name === column)
}

/**
 * Apply every migration whose `toVersion` exceeds the DB's current version, in
 * order. Called only for a pre-existing DB (a fresh one is already at
 * SCHEMA_VERSION), so the `fromVersion` guard skips migrations an upgraded DB has
 * already run — the v2 `ALTER` therefore fires exactly once per old DB (§10).
 *
 * `unlessColumnExists` (first used for v10) skips a migration's statements
 * entirely when the guard column is already present — see the field's doc on
 * {@link Migration} for why that can be true even though `fromVersion` says the
 * migration hasn't "run" yet (the column arrived via bootstrap's `CREATE TABLE
 * IF NOT EXISTS`, not a prior migration).
 */
function runMigrations(db: SqliteDb, fromVersion: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.toVersion > fromVersion) {
      if (
        migration.unlessColumnExists &&
        columnExists(db, migration.unlessColumnExists.table, migration.unlessColumnExists.column)
      ) {
        continue
      }
      for (const stmt of migration.statements) {
        db.exec(stmt)
      }
    }
  }
}
