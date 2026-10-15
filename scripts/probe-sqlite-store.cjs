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
const v9Dir = mkdtempSync(join(tmpdir(), 'octopus-sqlite-probe-v9-'))
const v9DbPath = join(v9Dir, 'octopus.db')

// The built probe module (bundled from open-database.ts) only re-exports
// `openSqliteStore`, not `SCHEMA_VERSION` from schema.ts — and this script may
// only touch itself, not the esbuild entry point or package.json's build
// command. SCHEMA_VERSION is 10 as of the Jira-import
// migration (schema.ts); keep this literal in lockstep with that export by
// hand, same as the `toVersion: 10` migration entry it probes below.
const CURRENT_SCHEMA_VERSION = 10

const result = {
  abi: process.versions.modules,
  open: 'FAIL',
  roundTrip: 'FAIL',
  checkpoint: 'FAIL',
  reload: 'FAIL',
  v7Migration: 'FAIL',
  v7Backup: 'FAIL',
  v7IssuesColumns: 'FAIL',
  v7JiraIndex: 'FAIL',
  issueRoundTrip: 'FAIL',
  issueUnbindOnTaskDelete: 'FAIL',
  issueUniqueTaskId: 'FAIL',
  upsertTaskKeepsBinding: 'FAIL',
  issueOrdering: 'FAIL',
  v9toV10: 'FAIL',
  v10Backup: 'FAIL',
  jiraKeyUnique: 'FAIL',
  sourceCheck: 'FAIL',
  sourceKeyCheck: 'FAIL',
  nullKeysAllowed: 'FAIL',
  jiraRoundTrip: 'FAIL'
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

// ---- v7 → current migration + issues probe (I19) ----
// Hand-build a v7-shaped on-disk DB (every table/column up to and including v7's
// own `repo_less` addition, but NOT the v8 `issues` table), then open it through
// the real adapter and confirm: the pre-migration backup is written, the DB lands
// on CURRENT_SCHEMA_VERSION (v8 → v10 migrations all applied), issues round-trip through the real binary, the UNIQUE
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
  // Stale check regression guard: this used to hardcode `=== 8` (the version
  // at which the v7 DB's upgrade landed when I19 first wrote this probe). The
  // v7 path now runs every migration up to the CURRENT schema in one open, so
  // compare against that, not a frozen snapshot of it.
  result.v7Migration =
    version === CURRENT_SCHEMA_VERSION ? 'OK' : 'FAIL (user_version=' + version + ')'

  // v10 (Jira import): confirm the v7→v10 path actually lands both new
  // `issues` columns and the `jira_key` UNIQUE index, not just the right
  // `user_version` (the index is created separately from either the bootstrap
  // DDL or the guarded migration — see `SqliteStore.create` — so it is worth
  // checking on its own).
  const rawColumnsCheck = new Database(migrateDbPath, { readonly: true })
  try {
    const issuesColumns = rawColumnsCheck.pragma('table_info(issues)').map((c) => c.name)
    const hasSource = issuesColumns.includes('source')
    const hasJiraKey = issuesColumns.includes('jira_key')
    result.v7IssuesColumns =
      hasSource && hasJiraKey ? 'OK' : 'FAIL (columns=' + JSON.stringify(issuesColumns) + ')'

    const issuesIndexes = rawColumnsCheck.pragma('index_list(issues)').map((i) => i.name)
    result.v7JiraIndex = issuesIndexes.includes('idx_issues_jira_key')
      ? 'OK'
      : 'FAIL (indexes=' + JSON.stringify(issuesIndexes) + ')'
  } finally {
    rawColumnsCheck.close()
  }

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
    updatedAt: 100,
    source: 'local'
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
      updatedAt: 101,
      source: 'local'
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
    updatedAt: 200,
    source: 'local'
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

// ---- v9 → v10 migration + Jira-import constraints probe ----
// Hand-build a v9-shaped on-disk DB: every table up to and including v9's own
// `session_groups` addition, with an `issues` table that has NEITHER `source`
// NOR `jira_key` (the v8/v9 shape) and one pre-existing row, stamped at
// `user_version = 9`. Opening it through the real adapter must run ONLY the
// guarded v10 migration (both ALTERs — `unlessColumnExists` is false here,
// unlike the v7 path where bootstrap's `CREATE TABLE IF NOT EXISTS` already
// creates `issues` pre-shaped with both columns), write the `.bak-v9`
// pre-migration backup, and leave the old row readable as `source: 'local'`
// with no `jiraKey`. The same opened store then exercises the v10
// constraints (`jira_key` UNIQUE, `source` CHECK, NULLs allowed, and a
// jira-sourced issue's round trip) against the real binary.
try {
  const rawV9 = new Database(v9DbPath)
  rawV9.exec(`CREATE TABLE IF NOT EXISTS tasks (
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
  rawV9.exec(`CREATE TABLE IF NOT EXISTS sessions (
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
  rawV9.exec(`CREATE TABLE IF NOT EXISTS app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`)
  rawV9.exec(`CREATE TABLE IF NOT EXISTS windows (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL CHECK(role IN ('main','secondary')),
     x INTEGER NOT NULL DEFAULT 0,
     y INTEGER NOT NULL DEFAULT 0,
     width INTEGER NOT NULL DEFAULT 1280,
     height INTEGER NOT NULL DEFAULT 800,
     created_at INTEGER NOT NULL
   )`)
  rawV9.exec(`CREATE TABLE IF NOT EXISTS session_scrollback (
     session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     data TEXT NOT NULL
   )`)
  rawV9.exec('CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, position)')
  // The v8/v9 shape: no `source`, no `jira_key`.
  rawV9.exec(`CREATE TABLE IF NOT EXISTS issues (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     project_path TEXT,
     status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','in_review','done')),
     task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`)
  rawV9.exec(`CREATE TABLE IF NOT EXISTS session_groups (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     layout TEXT NOT NULL,
     color INTEGER NOT NULL
   )`)
  rawV9.exec('CREATE INDEX IF NOT EXISTS idx_session_groups_task ON session_groups(task_id)')
  rawV9
    .prepare(
      `INSERT INTO issues (id, name, description, project_path, status, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('oi1', 'old issue', '', null, 'todo', null, 100, 100)
  rawV9.pragma('user_version = 9')
  rawV9.close()

  const v9Store = openSqliteStore(v9DbPath)

  const backupPathV9 = `${v9DbPath}.bak-v9`
  result.v10Backup = existsSync(backupPathV9) ? 'OK' : 'FAIL (no backup file written)'

  const rawV9Check = new Database(v9DbPath, { readonly: true })
  const v9Version = rawV9Check.pragma('user_version', { simple: true })
  rawV9Check.close()

  const v9Snap = v9Store.load()
  const oldIssue = (v9Snap.issues || []).find((i) => i.id === 'oi1')
  result.v9toV10 =
    v9Version === CURRENT_SCHEMA_VERSION &&
    oldIssue !== undefined &&
    oldIssue.source === 'local' &&
    oldIssue.jiraKey === undefined
      ? 'OK'
      : 'FAIL (user_version=' + v9Version + ') ' + JSON.stringify(oldIssue)

  // jira_key UNIQUE: a second jira-sourced issue with the SAME key must throw.
  v9Store.upsertIssue({
    id: 'jk1',
    name: 'jira issue 1',
    description: '',
    status: 'todo',
    taskId: undefined,
    createdAt: 300,
    updatedAt: 300,
    source: 'jira',
    jiraKey: 'JIRA-1'
  })
  try {
    v9Store.upsertIssue({
      id: 'jk2',
      name: 'jira issue 2',
      description: '',
      status: 'todo',
      taskId: undefined,
      createdAt: 301,
      updatedAt: 301,
      source: 'jira',
      jiraKey: 'JIRA-1'
    })
    result.jiraKeyUnique = 'FAIL (did not throw)'
  } catch (err) {
    const msg = String((err && err.message) || err)
    result.jiraKeyUnique = /UNIQUE constraint failed: issues\.jira_key/.test(msg)
      ? 'OK'
      : 'FAIL (wrong error) ' + msg
  }

  // source CHECK: a row outside ('local','jira') must throw.
  try {
    v9Store.upsertIssue({
      id: 'bogus1',
      name: 'bogus source',
      description: '',
      status: 'todo',
      taskId: undefined,
      createdAt: 302,
      updatedAt: 302,
      source: 'bogus',
      jiraKey: undefined
    })
    result.sourceCheck = 'FAIL (did not throw)'
  } catch (err) {
    const msg = String((err && err.message) || err)
    result.sourceCheck = /CHECK constraint failed/.test(msg) ? 'OK' : 'FAIL (wrong error) ' + msg
  }

  // source/jira_key consistency CHECK (added by the v10 ALTER on this upgraded
  // DB): 'jira' without a key and 'local' with a key must both throw.
  {
    const rejected = [
      { id: 'bogus2', source: 'jira', jiraKey: undefined },
      { id: 'bogus3', source: 'local', jiraKey: 'TM-9999' }
    ].map(({ id, source, jiraKey }) => {
      try {
        v9Store.upsertIssue({
          id,
          name: 'inconsistent',
          description: '',
          status: 'todo',
          taskId: undefined,
          createdAt: 302,
          updatedAt: 302,
          source,
          jiraKey
        })
        return 'did not throw'
      } catch (err) {
        const msg = String((err && err.message) || err)
        return /CHECK constraint failed/.test(msg) ? 'OK' : 'wrong error ' + msg
      }
    })
    result.sourceKeyCheck = rejected.every((r) => r === 'OK') ? 'OK' : 'FAIL ' + rejected.join('; ')
  }

  // Two NULL jira_keys are allowed (NULLs are distinct under a unique index).
  try {
    v9Store.upsertIssue({
      id: 'null1',
      name: 'local issue 1',
      description: '',
      status: 'todo',
      taskId: undefined,
      createdAt: 303,
      updatedAt: 303,
      source: 'local',
      jiraKey: undefined
    })
    v9Store.upsertIssue({
      id: 'null2',
      name: 'local issue 2',
      description: '',
      status: 'todo',
      taskId: undefined,
      createdAt: 304,
      updatedAt: 304,
      source: 'local',
      jiraKey: undefined
    })
    const bothSnap = v9Store.load()
    const null1 = (bothSnap.issues || []).find((i) => i.id === 'null1')
    const null2 = (bothSnap.issues || []).find((i) => i.id === 'null2')
    result.nullKeysAllowed =
      null1 !== undefined &&
      null1.jiraKey === undefined &&
      null2 !== undefined &&
      null2.jiraKey === undefined
        ? 'OK'
        : 'FAIL ' + JSON.stringify({ null1, null2 })
  } catch (err) {
    result.nullKeysAllowed = 'FAIL (threw) ' + String((err && err.message) || err)
  }

  // jira-sourced issue round trip: close, reopen, reload — source and jiraKey
  // must survive through the real binary, not just in-process.
  v9Store.checkpointAndClose()
  const reopenedV9 = openSqliteStore(v9DbPath)
  const reopenedSnap = reopenedV9.load()
  const reloadedJira = (reopenedSnap.issues || []).find((i) => i.id === 'jk1')
  result.jiraRoundTrip =
    reloadedJira !== undefined &&
    reloadedJira.source === 'jira' &&
    reloadedJira.jiraKey === 'JIRA-1'
      ? 'OK'
      : 'FAIL ' + JSON.stringify(reloadedJira)
  reopenedV9.checkpointAndClose()
} catch (e) {
  result.v9MigrationError = String((e && e.stack) || e)
} finally {
  rmSync(v9Dir, { recursive: true, force: true })
}

process.stdout.write('\nRESULT ' + JSON.stringify(result) + '\n')
const pass =
  result.open === 'OK' &&
  result.roundTrip === 'OK' &&
  result.checkpoint === 'OK' &&
  result.reload === 'OK' &&
  result.v7Migration === 'OK' &&
  result.v7Backup === 'OK' &&
  result.v7IssuesColumns === 'OK' &&
  result.v7JiraIndex === 'OK' &&
  result.issueRoundTrip === 'OK' &&
  result.issueUnbindOnTaskDelete === 'OK' &&
  result.issueUniqueTaskId === 'OK' &&
  result.upsertTaskKeepsBinding === 'OK' &&
  result.issueOrdering === 'OK' &&
  result.v9toV10 === 'OK' &&
  result.v10Backup === 'OK' &&
  result.jiraKeyUnique === 'OK' &&
  result.sourceCheck === 'OK' &&
  result.sourceKeyCheck === 'OK' &&
  result.nullKeysAllowed === 'OK' &&
  result.jiraRoundTrip === 'OK'
process.exit(pass ? 0 : 1)
