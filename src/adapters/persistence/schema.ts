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
 * a fresh spawn after a daemon-less restart lands where the user left off, §6.2);
 * 6 → 7 to add the `tasks.repo_less` column ("No Repo" tasks, §5.4 — a permanently
 * worktree-less task; its row stores `worktree = ''` and `repo_less = 1`); 7 → 8
 * (I19) to add the `issues` table — a locally-tracked work item optionally bound
 * 1:1 to a task via the UNIQUE, nullable `issues.task_id`, `ON DELETE SET NULL` so
 * deleting a task frees its issue instead of orphaning the FK; 8 → 9 to add the
 * `session_groups` table (DESIGN §5.7, §6.3 — split groups: 2+ sessions of one
 * task, in one window, sharing a layout tree and a palette color; one row per
 * group, `layout` an opaque JSON blob of the domain's `GroupTree` the backend never
 * interprets, membership is the tree's leaves). An unshipped dev build stamped v8
 * with a `split_layouts` table (the first, per-task-per-window split-pane version)
 * and no `issues` table; v9 drops the former and creates the latter if missing.
 * 9 → 10 (Jira import) to add `issues.source` (default `'local'`, checked against
 * `IssueSource`) and `issues.jira_key` (nullable, UNIQUE via a separate index —
 * SQLite's `ALTER TABLE ADD COLUMN` cannot add a `UNIQUE` column, and `NULL`s are
 * distinct under a unique index, so any number of `local` issues coexist). The v10
 * migration is guarded (see {@link Migration.unlessColumnExists}) because, unlike
 * every migration before it, the new columns are NOT just appended to an existing
 * table: a v7 DB (pre-Issues) has no `issues` table at all yet, so on THAT upgrade
 * path the bootstrap `CREATE TABLE IF NOT EXISTS issues` below (which already has
 * the v10 columns) creates the table for the first time on this very open — a bare
 * `ALTER TABLE issues ADD COLUMN source ...` right after would fail "duplicate
 * column". `SqliteStore` runs the guarded migrations when an older DB opens (see
 * {@link MIGRATIONS}).
 */
export const SCHEMA_VERSION = 10

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
     managed INTEGER NOT NULL DEFAULT 1,
     repo_less INTEGER NOT NULL DEFAULT 0
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
  `CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, position)`,
  // Issues (I19): a locally-tracked work item, optionally bound 1:1 to a task.
  // `task_id` is UNIQUE (one task per issue) and nullable (an unbound issue), with
  // `ON DELETE SET NULL` so deleting a task frees the issue's binding rather than
  // deleting the issue or violating the FK. The binding is stored only here — a
  // task row never carries a reverse pointer.
  `CREATE TABLE IF NOT EXISTS issues (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     project_path TEXT,
     status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','in_review','done')),
     task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','jira')),
     jira_key TEXT CHECK((source = 'jira') = (jira_key IS NOT NULL))
   )`,
  // NOTE: `idx_issues_jira_key` (the UNIQUE index on `issues.jira_key`, v10) is
  // deliberately NOT listed here, unlike every other index in this file. These
  // SCHEMA_STATEMENTS run on EVERY open, before any migration — on a v8/v9 DB
  // `issues` already exists without `jira_key` at that point (the column is added
  // later, by the guarded v10 migration), so an unconditional `CREATE INDEX ...
  // ON issues(jira_key)` here would throw "no such column: jira_key" (verified
  // against the real better-sqlite3 binary). `SqliteStore.create` instead creates
  // this index itself, unconditionally, strictly AFTER both these statements and
  // any migrations have run — see the comment there.
  // Split groups (DESIGN §5.7): 2+ sessions of one task, in one window, sharing a
  // layout tree and a palette color. `layout` is an opaque JSON blob (the domain's
  // `GroupTree`, leaves are member session ids) the backend never interprets, like
  // window bounds being presentation-only. `task_id` cascades: deleting the task
  // drops its groups with no explicit cleanup, mirroring `session_scrollback`'s
  // cascade-on-session-delete above. `color` is the palette index
  // (`0..GROUP_COLOR_PALETTE_SIZE-1`, §5.7); the backend assigns and persists it.
  `CREATE TABLE IF NOT EXISTS session_groups (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     layout TEXT NOT NULL,
     color INTEGER NOT NULL
   )`,
  // Fetching a task's groups is a hot read on load too: `SqliteStore.load`
  // orders this table by `task_id` (then `rowid` as a tiebreak, since groups
  // have no `position`-like column of their own, unlike `idx_sessions_task`'s
  // sessions), so this index serves that scan the same way idx_sessions_task
  // serves the sessions one.
  `CREATE INDEX IF NOT EXISTS idx_session_groups_task ON session_groups(task_id)`
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
  /**
   * Skip this migration's `statements` ENTIRELY when `table.column` already
   * exists (first used for v10, Jira import). Needed because bootstrap's
   * {@link SCHEMA_STATEMENTS} runs before any migration — if the table in
   * question did not exist on this DB until THIS open's `CREATE TABLE IF NOT
   * EXISTS` just created it (true for a v7 DB, where `issues` is added only at
   * v8), it is created already shaped with the new column, and an `ALTER TABLE
   * ... ADD COLUMN` migration for that same column would fail "duplicate
   * column". On a DB where the table already existed in its OLD shape (v8/v9 for
   * `issues`), the column is genuinely missing and the migration must run.
   * Checked via `PRAGMA table_info` in `runMigrations` (sqlite-store.ts).
   */
  readonly unlessColumnExists?: { readonly table: string; readonly column: string }
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
  },
  // v7 (§5.4): "No Repo" tasks. The NOT NULL DEFAULT 0 migrates every existing row
  // to non-repo-less with no UPDATE pass; a repo-less row stores `worktree = ''`
  // and `repo_less = 1`, and `rowToTaskSnapshot` branches on `repo_less` before
  // reading the (empty) worktree column, so the sentinel is never read as a path.
  {
    toVersion: 7,
    statements: Object.freeze(['ALTER TABLE tasks ADD COLUMN repo_less INTEGER NOT NULL DEFAULT 0'])
  },
  // v8 (I19): the `issues` table. Identical DDL to the fresh-DB bootstrap above —
  // `CREATE TABLE IF NOT EXISTS` is safe to re-run and matches it exactly, same
  // pattern as the v3 `session_scrollback` migration.
  {
    toVersion: 8,
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS issues (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         project_path TEXT,
         status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','in_review','done')),
         task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`
    ])
  },
  // v9 (DESIGN §5.7): split groups. The CREATEs mirror the fresh-DB DDL above
  // exactly, so they are safe to re-run under the `user_version` guard. No existing
  // row needs to migrate — an older DB simply has no groups yet, which is exactly
  // "no splits" for every task. The `issues` CREATE re-runs v8's DDL to heal an
  // unshipped dev DB that a split-pane build stamped v8 without that table, and the
  // DROP sheds that build's `split_layouts` table; both no-op on a real v8 DB.
  {
    toVersion: 9,
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS issues (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         project_path TEXT,
         status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','in_review','done')),
         task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS session_groups (
         id TEXT PRIMARY KEY,
         task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
         layout TEXT NOT NULL,
         color INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_session_groups_task ON session_groups(task_id)`,
      'DROP TABLE IF EXISTS split_layouts'
    ])
  },
  // v10 (Jira import): `issues.source` (default 'local', checked) and
  // `issues.jira_key` (nullable). Guarded with `unlessColumnExists`: on a v7 DB
  // (pre-Issues) the bootstrap `CREATE TABLE IF NOT EXISTS issues` above has just
  // created the table for the FIRST time on this open, already shaped with both
  // columns — so these `ALTER`s would fail "duplicate column" on exactly that
  // path (and, moot but harmless to note, on a fresh DB too, except migrations
  // never run there at all). On a v8/v9 DB `issues` already existed in its OLD
  // shape, missing both columns, so the guard is false and the `ALTER`s run.
  // The `jira_key` UNIQUE index is deliberately NOT appended here (nor to
  // SCHEMA_STATEMENTS) — see the long comment on `idx_issues_jira_key` above and
  // on the index-creation line in `SqliteStore.create`: bundling it into this
  // guarded migration would skip it on exactly the v7 path that still needs it
  // (the guard above is right for the ALTERs, wrong for the index, since the
  // column already existing doesn't mean the index does), and listing it
  // unconditionally in SCHEMA_STATEMENTS fails on v8/v9 (runs before the ALTERs
  // above, when the column is still missing). `SqliteStore.create` creates the
  // index itself, once, strictly after both SCHEMA_STATEMENTS and all migrations
  // (this one included) have run — the one point in the open sequence where the
  // column is guaranteed to exist on every DB shape.
  {
    toVersion: 10,
    unlessColumnExists: { table: 'issues', column: 'source' },
    statements: Object.freeze([
      `ALTER TABLE issues ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','jira'))`,
      // The CHECK mirrors the domain invariant (a Jira-sourced issue has a key, a key
      // implies Jira) so a row `Issue.fromSnapshot` would reject can't be written.
      `ALTER TABLE issues ADD COLUMN jira_key TEXT CHECK((source = 'jira') = (jira_key IS NOT NULL))`
    ])
  }
])
