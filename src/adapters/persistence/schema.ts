/**
 * SQLite schema for the workspace store (DESIGN §6.3). Pure module — no
 * better-sqlite3 import — so it is unit-testable under host Node (the native
 * binary is built for Electron's ABI and cannot `dlopen` here).
 *
 * The DDL follows §6.3 verbatim for `tasks`/`app_state`, and for `sessions` adds
 * one column beyond the "(simplified)" doc schema: `config TEXT NOT NULL`, the
 * full serialized {@link SessionConfig}. §3 requires `SessionConfig` to be fully
 * serializable, and §10 requires adding a session type (V3 Jenkins) with ZERO
 * schema edits — a lone `shell` column cannot hold a Jenkins config, so the full
 * config is persisted now. This is the V1 schema-definition seam §10 mandates,
 * not a later migration.
 *
 * What is deliberately NOT a column (I13 — never persist live process state):
 * task/session lifecycle. A persisted task row always has a worktree (`NOT NULL`)
 * so it reloads as `Ready` (reconcile demotes to `Stale` if the path is gone,
 * I14); a persisted session reloads as a fresh `Created` runtime (§6.3 "open a
 * fresh PTY in the worktree").
 */

/**
 * Schema version, stamped into `PRAGMA user_version` (§10). Bumped 1 → 2 to add
 * the nullable `base_ref` column (the worktree's source branch); 2 → 3 to add the
 * `session_scrollback` table (persisted terminal output, replayed on restart —
 * the realized §6.6 backend ring-buffer seam); 3 → 4 (V1.5, §6.3) to add the
 * `sessions.window_id` column and the `windows` table (multi-window placement);
 * 4 → 5 to add the `tasks.managed` column (Octopus-provisioned vs. adopted-repo
 * worktree — the latter is left on disk when the task is deleted, §6.4); 5 → 6 to
 * add the nullable `sessions.last_cwd` column (the session's last-known working
 * directory, captured from the daemon's `/proc/<pid>/cwd` on quit/roster-refresh so
 * a fresh spawn after a daemon-less restart lands where the user left off, §6.2).
 * `SqliteStore` runs the guarded migrations when an older DB opens (see
 * {@link MIGRATIONS}).
 */
export const SCHEMA_VERSION = 6

/**
 * Connection pragmas applied on every open. `foreign_keys` is per-connection
 * (not persisted) so the `ON DELETE CASCADE` on sessions actually fires; WAL is
 * persisted in the file but harmless to re-assert (§6.3, §6.6).
 */
export const CONNECTION_PRAGMAS: readonly string[] = Object.freeze([
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON'
])

/**
 * `CREATE TABLE ... IF NOT EXISTS` statements, in dependency order (tasks before
 * sessions for the FK). Executed once on open.
 */
export const SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     worktree TEXT NOT NULL,
     branch TEXT,
     base_ref TEXT,
     repo_root TEXT,
     created_at INTEGER NOT NULL,
     position INTEGER NOT NULL,
     active_session_id TEXT,
     managed INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     label TEXT NOT NULL,
     shell TEXT,
     config TEXT NOT NULL,
     position INTEGER NOT NULL,
     state TEXT NOT NULL DEFAULT 'unknown',
     created_at INTEGER NOT NULL,
     exited_at INTEGER,
     window_id TEXT NOT NULL DEFAULT 'main',
     last_cwd TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // V1.5 (§3.7, §6.7): one row per OS window. `role` distinguishes the single
  // main window (progress panel) from session-only secondary windows. Bounds are
  // saved debounced on move/resize and restored (with off-screen clamping) at boot.
  `CREATE TABLE IF NOT EXISTS windows (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL CHECK(role IN ('main','secondary')),
     x INTEGER NOT NULL DEFAULT 0,
     y INTEGER NOT NULL DEFAULT 0,
     width INTEGER NOT NULL DEFAULT 1280,
     height INTEGER NOT NULL DEFAULT 800,
     created_at INTEGER NOT NULL
   )`,
  // Persisted terminal output per session, replayed into a fresh PTY on restart
  // (§6.6 backend ring buffer). A separate table (not a `sessions` column) keeps
  // the hot `load()` startup read lean; `ON DELETE CASCADE` auto-purges the row
  // when its session is closed or its task deleted — no explicit cleanup needed.
  `CREATE TABLE IF NOT EXISTS session_scrollback (
     session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     data TEXT NOT NULL
   )`,
  // Fetching a task's sessions in tab order is the hot read on load (§6.3).
  `CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, position)`
])

/** `app_state` key holding the single active-task pointer (§6.3). */
export const ACTIVE_TASK_KEY = 'active_task_id'

/**
 * One schema migration: statements to run to reach `toVersion` from the version
 * just below it. `CREATE TABLE IF NOT EXISTS` bootstraps a *fresh* DB at the
 * current version, but it cannot add a column to a table an older launch already
 * created — so an existing v1 DB needs an explicit `ALTER`. Each migration is
 * applied only when `user_version < toVersion` and is idempotent-safe under the
 * `user_version` guard (§10, §6.3).
 */
export interface Migration {
  readonly toVersion: number
  readonly statements: readonly string[]
}

/**
 * Ordered migrations, first-used with v2's `base_ref`. `SqliteStore.create`
 * applies every migration whose `toVersion` exceeds the DB's current
 * `user_version`, then stamps `user_version = SCHEMA_VERSION`. The v3 migration
 * uses `CREATE TABLE IF NOT EXISTS` (identical DDL to {@link SCHEMA_STATEMENTS}),
 * so it is safe to re-run and matches the fresh-DB bootstrap exactly. The v5
 * migration adds `tasks.managed` (DEFAULT 1 so existing provisioned worktrees
 * keep deleting) and back-fills `managed = 0` for adopted rows — reliably
 * identified by `base_ref IS NULL`, since only a provisioned worktree records a
 * source branch (§6.4).
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { toVersion: 2, statements: Object.freeze(['ALTER TABLE tasks ADD COLUMN base_ref TEXT']) },
  {
    toVersion: 3,
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS session_scrollback (
         session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
         data TEXT NOT NULL
       )`
    ])
  },
  // V1.5 (§6.3): multi-window. The NOT NULL DEFAULT migrates every existing
  // session to the main window with no UPDATE pass; the CREATE mirrors the
  // fresh-DB DDL above; the INSERT OR IGNORE seeds the single main window row so
  // an upgraded DB always has a `main` record to fall back to (I18). All three are
  // safe to re-run under the `user_version` guard.
  {
    toVersion: 4,
    statements: Object.freeze([
      `ALTER TABLE sessions ADD COLUMN window_id TEXT NOT NULL DEFAULT 'main'`,
      `CREATE TABLE IF NOT EXISTS windows (
         id TEXT PRIMARY KEY,
         role TEXT NOT NULL CHECK(role IN ('main','secondary')),
         x INTEGER NOT NULL DEFAULT 0,
         y INTEGER NOT NULL DEFAULT 0,
         width INTEGER NOT NULL DEFAULT 1280,
         height INTEGER NOT NULL DEFAULT 800,
         created_at INTEGER NOT NULL
       )`,
      `INSERT OR IGNORE INTO windows (id, role, x, y, width, height, created_at)
         VALUES ('main', 'main', 0, 0, 1280, 800, CAST(strftime('%s','now') AS INTEGER) * 1000)`
    ])
  },
  // v5: distinguish Octopus-provisioned worktrees (deleted with the task) from
  // adopted repos/checkouts (left on disk). The DEFAULT 1 migrates every existing
  // row to "managed" with no UPDATE pass; the back-fill then marks pre-v5 adopted
  // rows (no source branch → `base_ref IS NULL`) as unmanaged (§6.4).
  {
    toVersion: 5,
    statements: Object.freeze([
      'ALTER TABLE tasks ADD COLUMN managed INTEGER NOT NULL DEFAULT 1',
      'UPDATE tasks SET managed = 0 WHERE base_ref IS NULL'
    ])
  },
  // v6 (§6.2): the session's last-known cwd, so a fresh spawn (daemon absent or the
  // PTY gone) can land where the user left off instead of at the worktree root. The
  // column is nullable — a pre-v6 session (or one never persisted a cwd) reads NULL
  // and falls back to the worktree, exactly as today.
  {
    toVersion: 6,
    statements: Object.freeze(['ALTER TABLE sessions ADD COLUMN last_cwd TEXT'])
  }
])
