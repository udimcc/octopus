// Real-binary smoke probe for SqliteStore (M2 verification), run under Electron's
// Node ABI via ELECTRON_RUN_AS_NODE=1 — no display, no Chromium, but the exact
// ABI (130) the packaged app uses, so better_sqlite3.node loads for real.
//
// vitest can't do this (host Node ABI 115 can't dlopen the binary), so the store
// unit tests use a fake db; this closes the gap end-to-end: open a real on-disk
// DB via the built adapter, round-trip a task + session in a transaction,
// checkpoint+close, reopen, and assert the reload matches minus live state (I13).
//
// Run: ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/probe-sqlite-store.cjs

const { mkdtempSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const Database = require('better-sqlite3')

const { openSqliteStore } = require(join(process.cwd(), 'out', 'probe', 'sqlite-probe.cjs'))

const dir = mkdtempSync(join(tmpdir(), 'octopus-sqlite-probe-'))
const dbPath = join(dir, 'octopus.db')
const migrateDir = mkdtempSync(join(tmpdir(), 'octopus-sqlite-probe-v7-'))
const migrateDbPath = join(migrateDir, 'octopus.db')
const result = {
  abi: process.versions.modules,
  open: 'FAIL',
  roundTrip: 'FAIL',
  checkpoint: 'FAIL',
  reload: 'FAIL',
  v7Migration: 'FAIL',
  v7Backup: 'FAIL',
  issueRoundTrip: 'FAIL',
  issueUnbindOnTaskDelete: 'FAIL',
  issueUniqueTaskId: 'FAIL',
  upsertTaskKeepsBinding: 'FAIL',
  issueOrdering: 'FAIL'
}

try {
  const store = openSqliteStore(dbPath)
  result.open = 'OK'

  const task = {
    id: 't1',
    name: 'probe task',
    worktree: {
      path: dir,
      branch: 'feature/probe',
      provisionedBy: { script: '/s.sh', args: ['a'], repoRoot: '/repo', provisionedAt: 1 }
    },
    lifecycle: 'ready',
    state: 'unknown',
    sessions: [],
    activeSessionId: 's1',
    position: 0,
    createdAt: 100
  }
  const session = {
    id: 's1',
    taskId: 't1',
    typeId: 'terminal',
    title: 'shell',
    config: { kind: 'terminal', shell: '/bin/bash', initialCommand: 'ls' },
    lifecycle: 'running',
    state: 'unknown',
    order: 0,
    createdAt: 100,
    exitedAt: undefined
  }

  store.transaction(() => {
    store.upsertTask(task)
    store.upsertSession(session)
    store.setActiveTask('t1')
  })
  result.roundTrip = 'OK'

  store.checkpointAndClose()
  result.checkpoint = 'OK'

  const reopened = openSqliteStore(dbPath)
  const snap = reopened.load()
  const t = snap.tasks[0]
  const s = t && t.sessions[0]
  const ok =
    snap.tasks.length === 1 &&
    t.id === 't1' &&
    t.lifecycle === 'ready' &&
    t.worktree &&
    t.worktree.branch === 'feature/probe' &&
    snap.activeTaskId === 't1' &&
    s &&
    s.id === 's1' &&
    s.lifecycle === 'created' && // fresh on reload (I13)
    s.config.initialCommand === 'ls'
  result.reload = ok ? 'OK' : 'MISMATCH ' + JSON.stringify(snap)
  reopened.checkpointAndClose()
} catch (e) {
  result.error = String((e && e.stack) || e)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ---- v7 → v8 migration + issues probe (I19) ----
// Hand-build a v7-shaped on-disk DB (every table/column up to and including v7's
// own `repo_less` addition, but NOT the v8 `issues` table), then open it through
// the real adapter and confirm: the pre-migration backup is written, the DB lands
// on user_version 8, issues round-trip through the real binary, the UNIQUE
// constraint on `issues.task_id` is enforced, deleting the bound task frees the
// issue via `ON DELETE SET NULL`, and a routine `upsertTask` (ON CONFLICT DO
// UPDATE, never INSERT OR REPLACE) does NOT clear an existing binding.
try {
  const rawV7 = new Database(migrateDbPath)
  rawV7.exec(`CREATE TABLE IF NOT EXISTS tasks (
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
   )`)
  rawV7.exec(`CREATE TABLE IF NOT EXISTS sessions (
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
   )`)
  rawV7.exec(`CREATE TABLE IF NOT EXISTS app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`)
  rawV7.exec(`CREATE TABLE IF NOT EXISTS windows (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL CHECK(role IN ('main','secondary')),
     x INTEGER NOT NULL DEFAULT 0,
     y INTEGER NOT NULL DEFAULT 0,
     width INTEGER NOT NULL DEFAULT 1280,
     height INTEGER NOT NULL DEFAULT 800,
     created_at INTEGER NOT NULL
   )`)
  rawV7.exec(`CREATE TABLE IF NOT EXISTS session_scrollback (
     session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     data TEXT NOT NULL
   )`)
  rawV7.exec('CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, position)')
  rawV7.pragma('user_version = 7')
  rawV7.close()

  const migrated = openSqliteStore(migrateDbPath)
  const backupPath = `${migrateDbPath}.bak-v7`
  if (!existsSync(backupPath)) {
    result.v7Backup = 'FAIL (no backup file written)'
  } else {
    const rawBackup = new Database(backupPath, { readonly: true })
    try {
      const backupVersion = rawBackup.pragma('user_version', { simple: true })
      const backupHasIssuesTable = rawBackup
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'issues'")
        .get()
      if (backupVersion !== 7) {
        result.v7Backup = 'FAIL (backup user_version=' + backupVersion + ')'
      } else if (backupHasIssuesTable) {
        result.v7Backup = 'FAIL (backup already has issues table)'
      } else {
        result.v7Backup = 'OK'
      }
    } finally {
      rawBackup.close()
    }
  }

  const rawCheck = new Database(migrateDbPath)
  const version = rawCheck.pragma('user_version', { simple: true })
  rawCheck.close()
  result.v7Migration = version === 8 ? 'OK' : 'FAIL (user_version=' + version + ')'

  const mTask = {
    id: 'mt1',
    name: 'migrated task',
    worktree: {
      path: migrateDir,
      branch: 'feature/migrate',
      managed: true,
      provisionedBy: { script: '/s.sh', args: [], repoRoot: '/repo', provisionedAt: 1 }
    },
    lifecycle: 'ready',
    state: 'unknown',
    sessions: [],
    activeSessionId: undefined,
    position: 0,
    createdAt: 100
  }
  const mIssue = {
    id: 'i1',
    name: 'probe issue',
    description: 'desc',
    projectPath: '/repo',
    status: 'in_progress',
    taskId: 'mt1',
    createdAt: 100,
    updatedAt: 100
  }
  migrated.upsertTask(mTask)
  migrated.upsertIssue(mIssue)

  // UNIQUE constraint on issues.task_id: a second issue bound to the SAME
  // already-bound task must throw, BEFORE the task is deleted below. Checking
  // the error message itself (m7) — not just "it threw something" — guards
  // against this passing for the wrong reason (e.g. a typo elsewhere in the
  // upsert that throws before ever reaching the UNIQUE constraint).
  try {
    migrated.upsertIssue({
      id: 'i2',
      name: 'second issue, same task',
      description: '',
      status: 'todo',
      taskId: 'mt1',
      createdAt: 101,
      updatedAt: 101
    })
    result.issueUniqueTaskId = 'FAIL (did not throw)'
  } catch (err) {
    const msg = String((err && err.message) || err)
    result.issueUniqueTaskId = /UNIQUE constraint failed: issues\.task_id/.test(msg)
      ? 'OK'
      : 'FAIL (wrong error) ' + msg
  }

  // Regression guard: re-upserting the already-bound task (ON CONFLICT DO UPDATE,
  // never INSERT OR REPLACE) must NOT clear the issue's binding via the
  // ON DELETE SET NULL trigger.
  migrated.upsertTask({ ...mTask, name: 'migrated task renamed' })

  migrated.checkpointAndClose()
  const reopenedMigrated = openSqliteStore(migrateDbPath)
  const reloadedSnap = reopenedMigrated.load()
  const reloadedIssue = (reloadedSnap.issues || []).find((i) => i.id === 'i1')
  const roundTripOk =
    reloadedIssue !== undefined &&
    reloadedIssue.name === 'probe issue' &&
    reloadedIssue.description === 'desc' &&
    reloadedIssue.status === 'in_progress' &&
    reloadedIssue.projectPath === '/repo' &&
    reloadedIssue.taskId === 'mt1' &&
    reloadedIssue.createdAt === 100 &&
    reloadedIssue.updatedAt === 100
  result.issueRoundTrip = roundTripOk ? 'OK' : 'MISMATCH ' + JSON.stringify(reloadedIssue)
  result.upsertTaskKeepsBinding =
    reloadedIssue !== undefined && reloadedIssue.taskId === 'mt1'
      ? 'OK'
      : 'FAIL (binding lost after upsertTask) ' + JSON.stringify(reloadedIssue)

  // Deleting the bound task frees the issue (ON DELETE SET NULL), not deletes it.
  reopenedMigrated.deleteTask('mt1')
  reopenedMigrated.checkpointAndClose()
  const finalStore = openSqliteStore(migrateDbPath)
  const finalSnap = finalStore.load()
  const finalIssue = (finalSnap.issues || []).find((i) => i.id === 'i1')
  result.issueUnbindOnTaskDelete =
    finalIssue !== undefined && finalIssue.taskId === undefined
      ? 'OK'
      : 'FAIL ' + JSON.stringify(finalIssue)

  // m6: ORDER BY created_at DESC, id — a second, more-recently-created
  // (unbound) issue must sort BEFORE the older 'i1' on reload.
  finalStore.upsertIssue({
    id: 'i3',
    name: 'newer issue',
    description: '',
    status: 'todo',
    taskId: undefined,
    createdAt: 200,
    updatedAt: 200
  })
  finalStore.checkpointAndClose()
  const orderStore = openSqliteStore(migrateDbPath)
  const orderedIds = (orderStore.load().issues || []).map((i) => i.id)
  result.issueOrdering =
    orderedIds[0] === 'i3' && orderedIds.includes('i1')
      ? 'OK'
      : 'FAIL ' + JSON.stringify(orderedIds)
  orderStore.checkpointAndClose()
} catch (e) {
  result.migrationError = String((e && e.stack) || e)
} finally {
  rmSync(migrateDir, { recursive: true, force: true })
}

process.stdout.write('\nRESULT ' + JSON.stringify(result) + '\n')
const pass =
  result.open === 'OK' &&
  result.roundTrip === 'OK' &&
  result.checkpoint === 'OK' &&
  result.reload === 'OK' &&
  result.v7Migration === 'OK' &&
  result.v7Backup === 'OK' &&
  result.issueRoundTrip === 'OK' &&
  result.issueUnbindOnTaskDelete === 'OK' &&
  result.issueUniqueTaskId === 'OK' &&
  result.upsertTaskKeepsBinding === 'OK' &&
  result.issueOrdering === 'OK'
process.exit(pass ? 0 : 1)
