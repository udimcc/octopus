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

const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { openSqliteStore } = require(join(process.cwd(), 'out', 'probe', 'sqlite-probe.cjs'))

const dir = mkdtempSync(join(tmpdir(), 'octopus-sqlite-probe-'))
const dbPath = join(dir, 'octopus.db')
const result = {
  abi: process.versions.modules,
  open: 'FAIL',
  roundTrip: 'FAIL',
  checkpoint: 'FAIL',
  reload: 'FAIL'
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

process.stdout.write('\nRESULT ' + JSON.stringify(result) + '\n')
const pass =
  result.open === 'OK' &&
  result.roundTrip === 'OK' &&
  result.checkpoint === 'OK' &&
  result.reload === 'OK'
process.exit(pass ? 0 : 1)
