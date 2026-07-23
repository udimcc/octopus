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
 * the nullable `base_ref` column (the worktree's source branch); `SqliteStore`
 * runs a guarded `ALTER TABLE` when an older DB opens (see {@link MIGRATIONS}).
 */
export const SCHEMA_VERSION = 2

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
     active_session_id TEXT
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
     exited_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
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
 * `user_version`, then stamps `user_version = SCHEMA_VERSION`.
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { toVersion: 2, statements: Object.freeze(['ALTER TABLE tasks ADD COLUMN base_ref TEXT']) }
])
