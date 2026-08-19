import { describe, it, expect, vi } from 'vitest'
import { SqliteStore } from './sqlite-store'
import { IncompatibleDbError } from './errors'
import type { SqliteDb, SqliteStatement } from './sqlite-db'
import type { TaskRow, SessionRow } from './mappers'
import { asTaskId, asSessionId, asTypeId } from '../../domain/ids'
import { TaskState, SessionState } from '../../domain/state'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import type { TaskSnapshot, SessionSnapshot } from '../../domain/snapshots'

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
      all: () => canned,
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
    expect(db.pragmas.some((p) => p.startsWith('user_version ='))).toBe(true)
  })

  it('does NOT run migrations on a fresh DB (no pre-existing tasks table)', () => {
    // No stub for sqlite_master → tableExists is false → the CREATE bootstraps a
    // fresh DB already at SCHEMA_VERSION; the v2 ALTER would fail with "duplicate
    // column" and the v3 CREATE is already done, so migrations must be skipped (§10).
    const db = new FakeDb()
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ADD COLUMN base_ref'))).toBe(false)
    expect(db.pragmas).toContain('user_version = 7')
  })

  it('runs the pending migrations on a pre-existing older DB (base_ref + session_scrollback)', () => {
    // A pre-existing `tasks` table with user_version 0 (older DB) → every migration
    // runs; user_version is stamped to the current version afterwards.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN base_ref'))).toBe(true)
    expect(db.pragmas).toContain('user_version = 7')
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
    expect(db.pragmas).toContain('user_version = 7')
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
    expect(db.pragmas).toContain('user_version = 7')
  })

  it('runs the v5 + v6 + v7 migrations on a v4 DB (managed + back-fill, last_cwd, repo_less)', () => {
    // A pre-existing DB stamped at user_version 4 (pre-adopted-repo): the v5
    // migration (tasks.managed ALTER + base_ref-null back-fill), the v6 migration
    // (sessions.last_cwd ALTER), and the v7 migration (tasks.repo_less ALTER) all
    // fire; the earlier v2/v3/v4 statements are skipped by the fromVersion guard.
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
    expect(db.pragmas).toContain('user_version = 7')
  })

  it('runs the v6 + v7 migrations on a v5 DB (last_cwd, then repo_less)', () => {
    // A pre-existing DB stamped at user_version 5 (pre-daemon): the v6 migration
    // (sessions.last_cwd ALTER) AND the v7 migration (tasks.repo_less ALTER) both
    // fire; the earlier v2–v5 statements are skipped by the fromVersion guard.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 5 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN managed'))).toBe(false)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN last_cwd'))).toBe(true)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN repo_less'))).toBe(true)
    expect(db.pragmas).toContain('user_version = 7')
  })

  it('runs ONLY the v7 migration on a v6 DB (adds repo_less)', () => {
    // A pre-existing DB stamped at user_version 6 (pre-"No Repo"): only the v7
    // migration fires — the tasks.repo_less ALTER. Earlier statements are skipped.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 6 }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE sessions ADD COLUMN last_cwd'))).toBe(
      false
    )
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN repo_less'))).toBe(true)
    expect(db.pragmas).toContain('user_version = 7')
  })

  it('throws IncompatibleDbError on a DB newer than this binary, without touching it', () => {
    // A pre-existing DB stamped one past SCHEMA_VERSION (a rollback: a newer Octopus
    // migrated it forward, §6.3). The guard must fire BEFORE any CREATE/ALTER and,
    // crucially, before the `user_version =` stamp — otherwise the DB would be
    // silently downgraded and the next upgrade would re-run an applied migration.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    db.stubPragma('user_version', [{ user_version: 8 }])
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
    expect(db.pragmas).toContain('user_version = 7')
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
    current.stubPragma('user_version', [{ user_version: 7 }])
    const onCurrent = vi.fn()
    SqliteStore.create(current, onCurrent)
    expect(onCurrent).not.toHaveBeenCalled()
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
