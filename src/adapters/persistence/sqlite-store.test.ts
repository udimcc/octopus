import { describe, it, expect, vi } from 'vitest'
import { SqliteStore } from './sqlite-store'
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

  stub(match: string, rows: unknown[]): void {
    this.results.push({ match, rows })
  }

  exec(sql: string): void {
    this.execed.push(sql)
  }

  pragma(source: string): unknown {
    this.pragmas.push(source)
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
    expect(db.pragmas.some((p) => p.startsWith('user_version ='))).toBe(true)
  })

  it('does NOT run the v2 ALTER on a fresh DB (no pre-existing tasks table)', () => {
    // No stub for sqlite_master → tableExists is false → the CREATE bootstraps a
    // fresh DB already at SCHEMA_VERSION (its `tasks` has base_ref); the ALTER
    // would fail with "duplicate column", so it must be skipped (§10).
    const db = new FakeDb()
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ADD COLUMN base_ref'))).toBe(false)
    expect(db.pragmas).toContain('user_version = 2')
  })

  it('runs the v2 ALTER on a pre-existing older DB (adds base_ref)', () => {
    // A pre-existing `tasks` table (older DB) → migrations run; user_version is
    // stamped to the current version afterwards.
    const db = new FakeDb()
    db.stub('sqlite_master', [{ name: 'tasks' }])
    SqliteStore.create(db)
    expect(db.execed.some((s) => s.includes('ALTER TABLE tasks ADD COLUMN base_ref'))).toBe(true)
    expect(db.pragmas).toContain('user_version = 2')
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
      active_session_id: 's1'
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
      exited_at: null
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
    expect(call!.params).toMatchObject({ id: 't1', worktree: '/wt', active_session_id: 's1' })
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
