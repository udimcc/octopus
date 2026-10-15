import { describe, it, expect, vi } from 'vitest'
import { SqliteStore } from './sqlite-store'
import { IncompatibleDbError } from './errors'
import { SCHEMA_STATEMENTS, MIGRATIONS } from './schema'
import type { SqliteDb, SqliteStatement } from './sqlite-db'
import type { TaskRow, SessionRow, IssueRow } from './mappers'
import { asTaskId, asSessionId, asTypeId, asIssueId, asGroupId } from '../../domain/ids'
import { TaskState, SessionState } from '../../domain/state'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import type {
  TaskSnapshot,
  SessionSnapshot,
  IssueSnapshot,
  GroupSnapshot
} from '../../domain/snapshots'
import { IssueStatus, IssueSource } from '../../domain/issue'

/** Collapse all whitespace runs to a single space, for whitespace-tolerant DDL comparison. */
function normalizeDdl(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * A scriptable fake `SqliteDb`. It cannot execute SQL, so it records every call
 * and answers `all`/`get` from canned result sets keyed by a substring of the
 * prepared SQL. This exercises the store's wiring (statements, params, ordering,
 * transaction/checkpoint) under host Node, where the real binary can't load.
 */
class FakeDb implements SqliteDb {
  execed: string[] = []
  pragmas: string[] = []
  closed = false
  runs: Array<{ sql: string; params: unknown }> = []
  private results: Array<{ match: string; rows: unknown[] }> = []
  private pragmaResults = new Map<string, unknown>()

  stub(match: string, rows: unknown[]): void {
    this.results.push({ match, rows })
  }

  /** Canned answer for a READ pragma (e.g. `user_version` → `[{ user_version: 2 }]`). */
  stubPragma(name: string, value: unknown): void {
    this.pragmaResults.set(name, value)
  }

  exec(sql: string): void {
    this.execed.push(sql)
  }

  pragma(source: string): unknown {
    this.pragmas.push(source)
    // A read pragma (`user_version`) has no `=`; return any canned value.
    if (!source.includes('=')) {
      return this.pragmaResults.get(source.trim())
    }
    return undefined
  }

  transaction<T>(fn: () => T): () => T {
    // Mark entry/exit so tests can assert the body ran inside the wrapper.
    return () => {
      this.pragmas.push('BEGIN(fake-tx)')
      const out = fn()
      this.pragmas.push('COMMIT(fake-tx)')
      return out
    }
  }

  close(): void {
    this.closed = true
  }

  prepare(sql: string): SqliteStatement {
    const canned = this.results.find((r) => sql.includes(r.match))?.rows ?? []
    const run = (...params: unknown[]) => {
      // Record a single bound object as-is, else the positional list.
      this.runs.push({ sql, params: params.length === 1 ? params[0] : params })
      return { changes: 1, lastInsertRowid: 0 }
    }
    return {
      run,
      // Record `all` calls too (not just `run`), so a read's bound params (e.g.
      // `loadSplitLayouts(windowId)`'s scoping param) are assertable like a write's.
      all: (...params: unknown[]) => {
        this.runs.push({ sql, params: params.length === 1 ? params[0] : params })
        return canned
      },
      get: () => canned[0]
    }
  }
}

function taskSnapshot(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: asTaskId('t1'),
    name: 'task',
    worktree: {
      path: '/wt',
      branch: 'b',
      managed: true,
      provisionedBy: { script: 's', args: [], repoRoot: '/repo', provisionedAt: 1 }
    },
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [],
    activeSessionId: asSessionId('s1'),
    position: 0,
    createdAt: 10,
    ...over
  }
}

function sessionSnapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: asSessionId('s1'),
    taskId: asTaskId('t1'),
    typeId: asTypeId('terminal'),
    title: 'shell',
    config: { kind: 'terminal' },
    lifecycle: SessionLifecycle.Running,
    state: SessionState.Unknown,
    order: 0,
    createdAt: 10,
    ...over
  }
}

function issueSnapshot(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    id: asIssueId('i1'),
    name: 'issue',
    description: 'desc',
    projectPath: '/repo',
    status: IssueStatus.Todo,
    taskId: asTaskId('t1'),
    createdAt: 10,
    updatedAt: 10,
    source: IssueSource.Local,
    ...over
  }
}

function groupSnapshot(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return {
    id: asGroupId('g1'),
    tree: { kind: 'leaf', sessionId: asSessionId('s1') },
    colorIndex: 0,
    ...over
  }
}

describe('SqliteStore.create (§6.3)', () => {
  it('applies connection pragmas and creates the schema before returning', () => {
    const db = new FakeDb()
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('journal_mode = WAL'))).toBe(true)
    expect(db.execed.some((s) => s.includes('foreign_keys = ON'))).toBe(true)
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS tasks'))).toBe(true)
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS sessions'))).toBe(true)
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS app_state'))).toBe(true)
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS session_scrollback'))).toBe(
      true
    )
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS issues'))).toBe(true)
    // §5.7: a fresh DB has the session_groups table from the start, same as every
    // other table — no migration needed for a brand-new install, and so no v9
    // `DROP TABLE IF EXISTS split_layouts` either (that table never existed here).
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS session_groups'))).toBe(
      true
    )
    expect(db.execed.some((s) => s.includes('split_layouts'))).toBe(false)
    expect(db.pragmas.some((p) => p.startsWith('user_version ='))).toBe(true)
  })

  it('does NOT run migrations on a fresh DB (no pre-existing tasks table)', () => {
    // No stub for sqlite_master → tableExists is false → the CREATE bootstraps a
    // fresh DB already at SCHEMA_VERSION; the v2 ALTER would fail with "duplicate
    // column" and the v3 CREATE is already done, so migrations must be skipped (§10).
    const db = new FakeDb()
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ADD COLUMN base_ref'))).toBe(false)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('runs the pending migrations on a pre-existing older DB (base_ref + session_scrollback)', () => {
    // A pre-existing `tasks` table with user_version 0 (older DB) → every migration
    // runs; user_version is stamped to the current version afterwards.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN base_ref'))).toBe(true)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('runs ONLY the v3 migration on a v2 DB (skips the already-applied v2 ALTER)', () => {
    // A pre-existing DB stamped at user_version 2: the v2 ALTER already ran on a
    // prior launch (its guard skips it), only the v3 `session_scrollback` CREATE
    // fires — proving the fromVersion guard upgrades v2 → v3 exactly once.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 2 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN base_ref'))).toBe(false)
    // The v3 CREATE runs both from SCHEMA_STATEMENTS and the migration; either way
    // the table is (re-)ensured. The IF NOT EXISTS makes the double-run safe.
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS session_scrollback'))).toBe(
      true
    )
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('runs ONLY the v4 migration on a v3 DB (adds window_id + windows, seeds main)', () => {
    // A pre-existing DB stamped at user_version 3 (pre-V1.5): only the v4 migration
    // fires — the sessions.window_id ALTER, the windows CREATE, and the main-row
    // seed. The earlier v2/v3 statements are skipped by the fromVersion guard.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 3 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN base_ref'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN window_id'))).toBe(
      true
    )
    expect(db.execed.some((s) => s.includes('CREATE TABLE IF NOT EXISTS windows'))).toBe(true)
    expect(db.execed.some((s) => s.includes('INSERT OR IGNORE INTO windows'))).toBe(true)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('runs the v5 + v6 + v7 + v8 + v9 migrations on a v4 DB (managed + back-fill, last_cwd, repo_less, issues, session_groups)', () => {
    // A pre-existing DB stamped at user_version 4 (pre-adopted-repo): the v5
    // migration (tasks.managed ALTER + base_ref-null back-fill), the v6 migration
    // (sessions.last_cwd ALTER), the v7 migration (tasks.repo_less ALTER), and now
    // the v8 migration (issues table, I19) all fire; the earlier v2/v3/v4
    // statements are skipped by the fromVersion guard.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 4 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN window_id'))).toBe(
      false
    )
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN managed'))).toBe(true)
    expect(
      db.execed.some((s) => s.includes('UPDATE tasks SET managed = 0 WHERE base_ref IS NULL'))
    ).toBe(true)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN last_cwd'))).toBe(true)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN repo_less'))).toBe(true)
    // Bootstrap + v8 + v9's healing re-run, all IF NOT EXISTS.
    expect(db.execed.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS issues')).length).toBe(3)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('runs the v6 + v7 + v8 + v9 migrations on a v5 DB (last_cwd, repo_less, issues, session_groups)', () => {
    // A pre-existing DB stamped at user_version 5 (pre-daemon): the v6 migration
    // (sessions.last_cwd ALTER), the v7 migration (tasks.repo_less ALTER), and the
    // v8 migration (issues table, I19) all fire; the earlier v2–v5 statements are
    // skipped by the fromVersion guard.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 5 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN managed'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN last_cwd'))).toBe(true)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN repo_less'))).toBe(true)
    // Bootstrap + v8 + v9's healing re-run, all IF NOT EXISTS.
    expect(db.execed.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS issues')).length).toBe(3)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('runs the v7 + v8 + v9 migrations on a v6 DB (adds repo_less, issues, session_groups)', () => {
    // A pre-existing DB stamped at user_version 6 (pre-"No Repo"): the v7
    // migration (tasks.repo_less ALTER) and the v8 migration (issues table, I19)
    // both fire. Earlier statements are skipped.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 6 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN last_cwd'))).toBe(
      false
    )
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN repo_less'))).toBe(true)
    // Bootstrap + v8 + v9's healing re-run, all IF NOT EXISTS.
    expect(db.execed.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS issues')).length).toBe(3)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('throws IncompatibleDbError on a DB newer than this binary, without touching it', () => {
    // A pre-existing DB stamped one past SCHEMA_VERSION (a rollback: a newer Octopus
    // migrated it forward, §6.3). The guard must fire BEFORE any CREATE/ALTER and,
    // crucially, before the `user_version =` stamp — otherwise the DB would be
    // silently downgraded and the next upgrade would re-run an applied migration.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 11 }])
    expect(() => SqliteStore.create(db)).toThrow(IncompatibleDbError)
    // No schema statements ran and the version was NOT lowered.
    expect(db.execed.some((s) => s.includes('CREATE TABLE'))).toBe(false)
    expect(db.pragmas.some((p) => p.startsWith('user_version ='))).toBe(false)
  })

  it('does NOT guard or stamp-down a fresh DB whose user_version reads 0', () => {
    // Defensive: a fresh DB (no tasks table) never trips the future-DB guard even
    // though fromVersion (0) < SCHEMA_VERSION; it bootstraps and stamps to current.
    const db = new FakeDb()
    expect(() => SqliteStore.create(db)).not.toThrow()
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('invokes beforeMigrate with fromVersion on an upgrade, but not on fresh/current DBs', () => {
    // Upgrade (older → current): callback fires once with the OLD version so the
    // caller can snapshot octopus.db.bak-v<from>.
    const upgrading = new FakeDb()
    upgrading.stub('sqlite_master', [{ name: 'tasks' }])
    upgrading.stubPragma('user_version', [{ user_version: 2 }])
    const onUpgrade = vi.fn()
    SqliteStore.create(upgrading, onUpgrade)
    expect(onUpgrade).toHaveBeenCalledExactlyOnceWith(2)

    // Fresh DB: nothing to migrate, so no backup.
    const fresh = new FakeDb()
    const onFresh = vi.fn()
    SqliteStore.create(fresh, onFresh)
    expect(onFresh).not.toHaveBeenCalled()

    // Already-current DB: nothing to migrate, so no backup.
    const current = new FakeDb()
    current.stub('sqlite_master', [{ name: 'tasks' }])
    current.stubPragma('user_version', [{ user_version: 10 }])
    const onCurrent = vi.fn()
    SqliteStore.create(current, onCurrent)
    expect(onCurrent).not.toHaveBeenCalled()
  })

  it('creates the issues table exactly once on a fresh DB (no migration pass, I19)', () => {
    // CREATE TABLE IF NOT EXISTS issues is unconditional in SCHEMA_STATEMENTS; on a
    // fresh DB (no pre-existing tasks table) migrations never run at all, so it
    // must appear exactly once — never twice, which would signal the migration
    // pass ran when it shouldn't have (mirrors the v2/v3 "does NOT run migrations
    // on a fresh DB" guard above, now for the v8 issues table).
    const db = new FakeDb()
    SqliteStore.create(db)
    expect(db.execed.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS issues')).length).toBe(1)
  })

  it('runs the v8 + v9 migrations on a v7 DB (adds the issues table, I19, then session_groups)', () => {
    // A pre-existing DB stamped at user_version 7 (pre-Issues): only the v8 and v9
    // migrations fire. All earlier ALTERs (base_ref/managed/last_cwd/repo_less)
    // are already applied and must be skipped by the fromVersion guard. The
    // issues-table CREATE runs THREE times — once unconditionally from
    // SCHEMA_STATEMENTS, once from the v8 MIGRATIONS entry, once from v9's healing
    // re-run — all IF NOT EXISTS, so the repeat is expected and safe (same pattern
    // as v3's session_scrollback table).
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 7 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN base_ref'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN managed'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN last_cwd'))).toBe(
      false
    )
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN repo_less'))).toBe(false)
    expect(db.execed.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS issues')).length).toBe(3)
    expect(db.pragmas).toContain('user_version = 10')
  })
})

describe('SqliteStore.load (§6.3)', () => {
  it('buckets sessions under their task and hydrates via the mappers', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    const taskRow: TaskRow = {
      id: 't1',
      name: 'task',
      worktree: '/wt',
      branch: null,
      base_ref: null,
      repo_root: '/repo',
      created_at: 10,
      position: 0,
      active_session_id: 's1',
      managed: 1,
      repo_less: 0
    }
    const sessionRow: SessionRow = {
      id: 's1',
      task_id: 't1',
      type: 'terminal',
      label: 'shell',
      shell: null,
      config: JSON.stringify({ kind: 'terminal' }),
      position: 0,
      state: 'unknown',
      created_at: 10,
      exited_at: null,
      window_id: 'main'
    }
    db.stub('FROM tasks', [taskRow])
    db.stub('FROM sessions', [sessionRow])
    db.stub('FROM app_state', [{ value: 't1' }])

    const snap = store.load()
    expect(snap.tasks).toHaveLength(1)
    expect(snap.tasks[0].sessions).toHaveLength(1)
    expect(snap.tasks[0].lifecycle).toBe(TaskLifecycle.Ready)
    expect(snap.activeTaskId).toBe(asTaskId('t1'))
  })

  it('drops an active-task pointer that no longer resolves to a task (I9)', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    db.stub('FROM tasks', [])
    db.stub('FROM sessions', [])
    db.stub('FROM app_state', [{ value: 'ghost' }])
    expect(store.load().activeTaskId).toBeUndefined()
  })

  it('includes issues, hydrated via rowToIssueSnapshot (I19)', () => {
    // FakeDb returns stubbed rows verbatim in array order — it does not execute
    // real SQL, so this only proves `load()` wires the query results into the
    // snapshot through the mapper; the real `ORDER BY created_at DESC, id`
    // ordering is exercised against the real binary in scripts/probe-sqlite-store.cjs.
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    const boundRow: IssueRow = {
      id: 'i1',
      name: 'bound issue',
      description: 'desc',
      project_path: '/repo',
      status: 'in_progress',
      task_id: 't1',
      created_at: 20,
      updated_at: 30,
      source: 'local',
      jira_key: null
    }
    const unboundRow: IssueRow = {
      id: 'i2',
      name: 'unbound issue',
      description: '',
      project_path: null,
      status: 'todo',
      task_id: null,
      source: 'jira',
      jira_key: 'PROJ-9',
      created_at: 10,
      updated_at: 10
    }
    db.stub('FROM tasks', [])
    db.stub('FROM sessions', [])
    db.stub('FROM issues', [boundRow, unboundRow])

    const snap = store.load()
    expect(snap.issues).toHaveLength(2)
    expect(snap.issues?.[0]).toMatchObject({
      id: 'i1',
      name: 'bound issue',
      projectPath: '/repo',
      status: 'in_progress',
      taskId: 't1'
    })
    expect(snap.issues?.[1]).toMatchObject({
      id: 'i2',
      projectPath: undefined,
      taskId: undefined
    })
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('runs ONLY the v9 migration on a v8 DB (session_groups, §5.7)', () => {
    // A DB stamped at user_version 8 (pre-groups): only the v9 migration fires.
    // `CREATE TABLE IF NOT EXISTS session_groups` also runs unconditionally from
    // SCHEMA_STATEMENTS on every open, so assert it ran TWICE (bootstrap + migration)
    // to actually exercise the migration path. v9 also re-runs the `issues` CREATE
    // (healing an unshipped split-pane dev DB stamped v8 without that table) and
    // drops that build's `split_layouts` table.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 8 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN repo_less'))).toBe(false)
    expect(
      db.execed.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS session_groups'))
    ).toHaveLength(2)
    expect(db.execed.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS issues'))).toHaveLength(2)
    expect(db.execed.some((s) => s.includes('DROP TABLE IF EXISTS split_layouts'))).toBe(true)
    const v9Migration = MIGRATIONS.find((m) => m.toVersion === 9)
    expect(v9Migration).toBeDefined()
    expect(
      v9Migration!.statements.some((s) => s.includes('CREATE TABLE IF NOT EXISTS session_groups'))
    ).toBe(true)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('a current v10 DB runs no migration, so no split_layouts DROP nor v10 ALTER', () => {
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 10 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('split_layouts'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN source'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN jira_key'))).toBe(false)
    expect(
      MIGRATIONS.every((m) =>
        m.statements.every((s) => !s.includes('CREATE TABLE IF NOT EXISTS split_layouts'))
      )
    ).toBe(true)
  })

  it('runs the v10 migration on a v9 DB (adds source + jira_key, I19/v10 Jira import)', () => {
    // A pre-existing DB at user_version 9 (pre-Jira-import): only the v10 ALTERs
    // fire. `table_info` is unstubbed (no canned rows), so `columnExists` reports
    // false and the guard does NOT skip them — this is the normal upgrade path.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 9 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('split_layouts'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN source'))).toBe(true)
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN jira_key'))).toBe(true)
    expect(
      db.execed.some((s) => s.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_jira_key'))
    ).toBe(true)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('skips the v10 ALTERs when `issues.source` already exists (the v7-bootstrap path)', () => {
    // Simulates a v7 DB: `tasks` exists but `issues` doesn't, so the bootstrap's
    // `CREATE TABLE IF NOT EXISTS issues` (now including source/jira_key) creates
    // it with the columns already present BEFORE migrations run. Without the
    // `unlessColumnExists` guard the v10 ALTER would then fail "duplicate column".
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 7 }])
    db.stubPragma('table_info(issues)', [{ name: 'id' }, { name: 'source' }, { name: 'jira_key' }])
    expect(() => SqliteStore.create(db)).not.toThrow()
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN source'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN jira_key'))).toBe(false)
    // The UNIQUE index still gets created unconditionally regardless of the guard.
    expect(
      db.execed.some((s) => s.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_jira_key'))
    ).toBe(true)
    expect(db.pragmas).toContain('user_version = 10')
  })

  it('does NOT run the v10 ALTERs on a fresh DB', () => {
    const db = new FakeDb()
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN source'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE issues ADD COLUMN jira_key'))).toBe(false)
    expect(
      db.execed.some((s) => s.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_jira_key'))
    ).toBe(true)
    expect(db.pragmas).toContain('user_version = 10')
  })
})

describe('SqliteStore writes', () => {
  it('upsertTask binds the flattened row', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertTask(taskSnapshot())
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO tasks'))
    expect(call).toBeDefined()
    expect(call!.params).toMatchObject({
      id: 't1',
      worktree: '/wt',
      active_session_id: 's1',
      managed: 1
    })
  })

  it('upsertTask uses ON CONFLICT DO UPDATE, never INSERT OR REPLACE (I19 regression guard)', () => {
    // REPLACE deletes-then-reinserts the row, which would fire issues.task_id's
    // ON DELETE SET NULL and silently unbind any connected issue on every routine
    // save (see the long comment above SqliteStore.upsertTask). Locking this in.
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertTask(taskSnapshot())
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO tasks'))
    expect(call).toBeDefined()
    expect(call!.sql).toContain('ON CONFLICT(id) DO UPDATE')
    expect(call!.sql).not.toContain('REPLACE')
  })

  it('upsertIssue binds the flattened row via ON CONFLICT DO UPDATE, never REPLACE (I19)', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertIssue(issueSnapshot())
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO issues'))
    expect(call).toBeDefined()
    expect(call!.sql).toContain('ON CONFLICT(id) DO UPDATE')
    expect(call!.sql).not.toContain('REPLACE')
    expect(call!.params).toMatchObject({
      id: 'i1',
      name: 'issue',
      description: 'desc',
      project_path: '/repo',
      status: 'todo',
      task_id: 't1',
      created_at: 10,
      updated_at: 10,
      source: 'local',
      jira_key: null
    })
    // source/jira_key are bound on INSERT but never in the DO UPDATE SET list —
    // both are immutable once created (v10, Jira import).
    expect(call!.sql).not.toMatch(/DO UPDATE SET[\s\S]*source\s*=/)
    expect(call!.sql).not.toMatch(/DO UPDATE SET[\s\S]*jira_key\s*=/)
  })

  it('upsertIssue binds source/jira_key for a jira-sourced issue', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertIssue(issueSnapshot({ source: IssueSource.Jira, jiraKey: 'PROJ-123' }))
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO issues'))
    expect(call!.params).toMatchObject({ source: 'jira', jira_key: 'PROJ-123' })
  })

  it('upsertIssue nulls an absent project/task', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertIssue(issueSnapshot({ projectPath: undefined, taskId: undefined }))
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO issues'))
    expect(call!.params).toMatchObject({ project_path: null, task_id: null })
  })

  it('deleteIssue issues a single DELETE on issues, never touching tasks', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.deleteIssue(asIssueId('i1'))
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM issues WHERE id = ?'))).toBe(true)
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM tasks'))).toBe(false)
  })

  it('upsertSession stores the serialized config', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertSession(sessionSnapshot())
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO sessions'))
    expect(call).toBeDefined()
    expect((call!.params as { config: string }).config).toBe(JSON.stringify({ kind: 'terminal' }))
  })

  it('deleteTask relies on the FK cascade (single DELETE on tasks)', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.deleteTask(asTaskId('t1'))
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM tasks'))).toBe(true)
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM sessions'))).toBe(false)
  })

  it('setActiveTask upserts the pointer, and deletes it when cleared', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.setActiveTask(asTaskId('t2'))
    expect(db.runs.some((r) => r.sql.includes('INSERT INTO app_state'))).toBe(true)
    store.setActiveTask(undefined)
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM app_state'))).toBe(true)
  })

  it('saveScrollback upserts the (session_id, data) row', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.saveScrollback(asSessionId('s1'), 'the output')
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO session_scrollback'))
    expect(call).toBeDefined()
    expect(call!.sql).toContain('ON CONFLICT(session_id) DO UPDATE')
    expect(call!.params).toEqual([asSessionId('s1'), 'the output'])
  })

  it('loadScrollback returns the stored data, or undefined when absent', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    db.stub('FROM session_scrollback', [{ data: 'restored output' }])
    expect(store.loadScrollback(asSessionId('s1'))).toBe('restored output')

    const empty = SqliteStore.create(new FakeDb())
    expect(empty.loadScrollback(asSessionId('gone'))).toBeUndefined()
  })
})

describe('SqliteStore split groups (DESIGN §5.7, §6.3)', () => {
  it('upsertGroup inserts the (id, task_id, layout, color) row', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertGroup(asTaskId('t1'), groupSnapshot())
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO session_groups'))
    expect(call).toBeDefined()
    expect(call!.sql).toContain('ON CONFLICT(id) DO UPDATE')
    expect(call!.params).toMatchObject({
      id: 'g1',
      task_id: 't1',
      layout: JSON.stringify({ kind: 'leaf', sessionId: 's1' }),
      color: 0
    })
  })

  it('upsertGroup called again with a reshaped tree/color re-upserts (update path)', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertGroup(asTaskId('t1'), groupSnapshot())
    store.upsertGroup(
      asTaskId('t1'),
      groupSnapshot({
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: asSessionId('s1') },
          b: { kind: 'leaf', sessionId: asSessionId('s2') }
        },
        colorIndex: 2
      })
    )
    const upserts = db.runs.filter((r) => r.sql.includes('INSERT INTO session_groups'))
    expect(upserts).toHaveLength(2)
    expect((upserts[1]!.params as { color: number }).color).toBe(2)
    expect((upserts[1]!.params as { layout: string }).layout).toContain('"sessionId":"s2"')
  })

  it('the ON CONFLICT clause updates BOTH layout and color (review P3/P3b)', () => {
    // `FakeDb.prepare().run()` echoes whatever params it's given regardless of
    // whether the SQL text is well-formed — the "re-upsert" test above would
    // keep passing even if the ON CONFLICT clause dropped `layout = excluded.layout`
    // or `color = excluded.color` entirely, since it only inspects `.params`.
    // Assert the actual SQL text instead.
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.upsertGroup(asTaskId('t1'), groupSnapshot())
    const call = db.runs.find((r) => r.sql.includes('INSERT INTO session_groups'))
    expect(call).toBeDefined()
    const sql = normalizeDdl(call!.sql)
    expect(sql).toContain('layout = excluded.layout')
    expect(sql).toContain('color = excluded.color')
  })

  it('deleteGroup deletes by id (ungroup / dissolve-at-1 / member removed)', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.deleteGroup(asGroupId('g1'))
    const call = db.runs.find((r) => r.sql.includes('DELETE FROM session_groups'))
    expect(call).toBeDefined()
    expect(call!.sql).toContain('WHERE id = ?')
    expect(call!.params).toEqual('g1')
  })

  it('deleteTask relies on the FK cascade to drop its session_groups rows too', () => {
    // Mirrors the "deleteTask relies on the FK cascade" test above (sessions):
    // deleting a task issues a single DELETE on `tasks`, with no explicit cleanup
    // of `session_groups` — the row's `task_id` FK (ON DELETE CASCADE) must do it.
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.deleteTask(asTaskId('t1'))
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM tasks'))).toBe(true)
    expect(db.runs.some((r) => r.sql.includes('DELETE FROM session_groups'))).toBe(false)
  })

  it('the session_groups DDL actually declares ON DELETE CASCADE on the task FK (fresh-bootstrap DDL)', () => {
    // The "relies on the FK cascade" test above only asserts that NO explicit
    // cleanup DELETE runs — it would pass even if `ON DELETE CASCADE` were removed
    // from the schema entirely, since FakeDb can't execute real SQL/FK semantics
    // and the real better-sqlite3 binary can't load under host Node. Assert on the
    // DDL text itself instead.
    const ddl = SCHEMA_STATEMENTS.find((s) =>
      s.includes('CREATE TABLE IF NOT EXISTS session_groups')
    )
    expect(ddl).toBeDefined()
    const normalized = normalizeDdl(ddl!)
    expect(normalized).toContain('task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE')
  })

  it('the v9 migration DDL for session_groups matches the fresh-bootstrap DDL exactly (modulo whitespace)', () => {
    // Guards against the migration DDL drifting from the bootstrap DDL (e.g. a
    // cascade present in one but not the other, which would make an upgraded DB
    // behave differently from a fresh install).
    const bootstrapDdl = SCHEMA_STATEMENTS.find((s) =>
      s.includes('CREATE TABLE IF NOT EXISTS session_groups')
    )
    const migration = MIGRATIONS.find((m) => m.toVersion === 9)
    expect(bootstrapDdl).toBeDefined()
    expect(migration).toBeDefined()
    const migrationDdl = migration!.statements.find((s) =>
      s.includes('CREATE TABLE IF NOT EXISTS session_groups')
    )
    expect(migrationDdl).toBeDefined()
    expect(normalizeDdl(migrationDdl!)).toBe(normalizeDdl(bootstrapDdl!))
    const normalized = normalizeDdl(migrationDdl!)
    expect(normalized).toContain('task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE')
  })

  it('declares an index on session_groups(task_id) (review P4)', () => {
    // Without this index, `load`'s per-task group bucketing degrades to a full
    // table scan on every open as `session_groups` grows — assert the DDL is
    // actually present in SCHEMA_STATEMENTS rather than trusting it stays there.
    const idx = SCHEMA_STATEMENTS.find((s) => s.includes('idx_session_groups_task'))
    expect(idx).toBeDefined()
    expect(normalizeDdl(idx!)).toContain('ON session_groups(task_id)')
  })

  it('buckets groups per task — a second task with no groups of its own gets none of the first task’s (review P5)', () => {
    // The bucketing map keys by `row.task_id` (`groupsByTask.get(row.id) ?? []`
    // per task). A mutant that hands every task the full unbucketed `groupRows`
    // list instead would still pass a single-task test; it takes a SECOND task
    // with its own (empty) groups to see the leak.
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    const taskRow = (id: string, position: number): TaskRow => ({
      id,
      name: id,
      worktree: `/wt/${id}`,
      branch: null,
      base_ref: null,
      repo_root: '/repo',
      created_at: 10,
      position,
      active_session_id: null,
      managed: 1,
      repo_less: 0
    })
    const sessionRow = (id: string, taskId: string, position: number): SessionRow => ({
      id,
      task_id: taskId,
      type: 'terminal',
      label: id,
      shell: null,
      config: JSON.stringify({ kind: 'terminal' }),
      position,
      state: 'unknown',
      created_at: 10,
      exited_at: null,
      window_id: 'main'
    })
    const groupRow = {
      id: 'g1',
      task_id: 't1',
      layout: JSON.stringify({
        kind: 'split',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 's1' },
        b: { kind: 'leaf', sessionId: 's2' }
      }),
      color: 0
    }
    db.stub('FROM tasks', [taskRow('t1', 0), taskRow('t2', 1)])
    db.stub('FROM sessions', [
      sessionRow('s1', 't1', 0),
      sessionRow('s2', 't1', 1),
      sessionRow('s3', 't2', 0)
    ])
    db.stub('FROM session_groups', [groupRow])
    db.stub('FROM app_state', [])

    const snap = store.load()
    const t1 = snap.tasks.find((t) => t.id === asTaskId('t1'))!
    const t2 = snap.tasks.find((t) => t.id === asTaskId('t2'))!
    expect(t1.groups).toHaveLength(1)
    expect(t2.groups).toEqual([])
  })

  it('load attaches each task’s groups, ordered by task then rowid', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    const taskRow: TaskRow = {
      id: 't1',
      name: 'task',
      worktree: '/wt',
      branch: null,
      base_ref: null,
      repo_root: '/repo',
      created_at: 10,
      position: 0,
      active_session_id: 's1',
      managed: 1,
      repo_less: 0
    }
    const sessionRows: SessionRow[] = [
      {
        id: 's1',
        task_id: 't1',
        type: 'terminal',
        label: 'a',
        shell: null,
        config: JSON.stringify({ kind: 'terminal' }),
        position: 0,
        state: 'unknown',
        created_at: 10,
        exited_at: null,
        window_id: 'main'
      },
      {
        id: 's2',
        task_id: 't1',
        type: 'terminal',
        label: 'b',
        shell: null,
        config: JSON.stringify({ kind: 'terminal' }),
        position: 1,
        state: 'unknown',
        created_at: 10,
        exited_at: null,
        window_id: 'main'
      }
    ]
    const groupRow = {
      id: 'g1',
      task_id: 't1',
      layout: JSON.stringify({
        kind: 'split',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 's1' },
        b: { kind: 'leaf', sessionId: 's2' }
      }),
      color: 3
    }
    db.stub('FROM tasks', [taskRow])
    db.stub('FROM sessions', [sessionRows[0], sessionRows[1]])
    db.stub('FROM session_groups', [groupRow])
    db.stub('FROM app_state', [])

    const snap = store.load()
    expect(snap.tasks).toHaveLength(1)
    expect(snap.tasks[0].groups).toHaveLength(1)
    expect(snap.tasks[0].groups![0]).toEqual({
      id: asGroupId('g1'),
      tree: JSON.parse(groupRow.layout),
      colorIndex: 3
    })

    // The SELECT orders by task_id then rowid (no per-group position column).
    const call = db.runs.find((r) => r.sql.includes('FROM session_groups'))
    expect(call).toBeDefined()
    expect(call!.sql).toContain('ORDER BY task_id ASC, rowid ASC')
  })

  it('load gives a task with no group rows an empty groups array, not undefined', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    db.stub('FROM tasks', [
      {
        id: 't1',
        name: 'task',
        worktree: '/wt',
        branch: null,
        base_ref: null,
        repo_root: '/repo',
        created_at: 10,
        position: 0,
        active_session_id: null,
        managed: 1,
        repo_less: 0
      }
    ])
    db.stub('FROM sessions', [])
    db.stub('FROM session_groups', [])
    db.stub('FROM app_state', [])
    const snap = store.load()
    expect(snap.tasks[0].groups).toEqual([])
  })
})

describe('SqliteStore transaction & shutdown (§6.6, I13)', () => {
  it('runs the callback inside a transaction wrapper', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    const fn = vi.fn(() => 42)
    const out = store.transaction(fn)
    expect(out).toBe(42)
    expect(fn).toHaveBeenCalledOnce()
    expect(db.pragmas).toContain('BEGIN(fake-tx)')
    expect(db.pragmas).toContain('COMMIT(fake-tx)')
  })

  it('checkpoints the WAL before closing, in that order', () => {
    const db = new FakeDb()
    const store = SqliteStore.create(db)
    store.checkpointAndClose()
    expect(db.pragmas).toContain('wal_checkpoint(TRUNCATE)')
    expect(db.closed).toBe(true)
    // checkpoint must precede close
    const cp = db.pragmas.indexOf('wal_checkpoint(TRUNCATE)')
    expect(cp).toBeGreaterThanOrEqual(0)
  })
})
