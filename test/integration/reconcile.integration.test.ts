/**
 * Restart-reconciliation, end to end (DESIGN §6.3 Restore, §7 I14). Unlike the
 * unit `reconcile.test.ts` (which injects a fake `existsDir` probe), this drives
 * `reconcileOnStartup` with the REAL `fs/dir-exists` adapter against REAL temp
 * directories, then proves the follow-on lazy-start path against the REAL PTY
 * stack (`PtySessionManager` + terminal `SessionTypeProvider`):
 *
 *   (a) a task whose worktree directory has been removed on disk → marked `Stale`
 *       + `taskStale` emitted, and NO runtime is started (I14); and
 *   (b) a task whose worktree is still present → stays `Ready`, and the first
 *       `switchTask` spawns a FRESH PTY at that worktree's cwd (§6.3 "open a fresh
 *       PTY"), which we confirm by reading `pwd` back off the `ptyData` stream.
 *
 * Only the worktree provider, persistence, settings, ids and clock are faked
 * (reused from the application test-fakes); everything on the runtime path is
 * production code. Skipped (not failed) when node-pty is not loadable/spawnable.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileOnStartup } from '../../src/application/reconcile'
import { switchTask } from '../../src/application/use-cases/switch-task'
import { MapRuntimeRegistry, type AppDependencies } from '../../src/application/dependencies'
import { createAjvConfigValidator } from '../../src/application/config-validator'
import { existsDir } from '../../src/adapters/fs/dir-exists'
import { Workspace } from '../../src/domain/workspace'
import { worstStatusWins } from '../../src/domain/task-state-aggregator'
import { asTaskId, asSessionId, asTypeId } from '../../src/domain/ids'
import { SessionLifecycle, TaskLifecycle } from '../../src/domain/lifecycle'
import { SessionState, TaskState } from '../../src/domain/state'
import { PtySessionManager } from '../../src/adapters/session/pty-session-manager'
import { RingBufferScrollbackStore } from '../../src/adapters/session/scrollback-store'
import { InMemorySessionTypeRegistry } from '../../src/adapters/session-types/session-type-registry'
import { TerminalSessionTypeProvider } from '../../src/adapters/session-types/terminal-session-type-provider'
import {
  FakePersistence,
  FakeSettingsStore,
  FakeWorktreeProvider,
  FakeSocketProvisioner,
  RecordingBus,
  SeqIdGenerator,
  FakeClock
} from '../../src/application/use-cases/test-fakes'
import type { WorkspaceSnapshot } from '../../src/domain/snapshots'
import type { DomainEvent } from '../../src/ports/event-bus'

const ptyOk = ((): boolean => {
  try {
    const require = createRequire(import.meta.url)
    const pty = require('node-pty') as typeof import('node-pty')
    const probe = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24 })
    probe.kill()
    return true
  } catch {
    return false
  }
})()

const d = ptyOk ? describe : describe.skip

/** A restored snapshot for one task at `path`, with one fresh `Created` session. */
function taskSnapshot(
  id: string,
  path: string,
  position: number
): WorkspaceSnapshot['tasks'][number] {
  return {
    id: asTaskId(id),
    name: id,
    worktree: {
      path,
      managed: true,
      provisionedBy: { script: 'git', args: [id], repoRoot: '/repo', provisionedAt: 1 }
    },
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [
      {
        id: asSessionId(`${id}-s1`),
        taskId: asTaskId(id),
        typeId: asTypeId('terminal'),
        title: 'Terminal 1',
        // No cwdOverride → the fresh PTY falls back to the worktree cwd (§6.1).
        config: { kind: 'terminal' as const },
        lifecycle: SessionLifecycle.Created,
        state: SessionState.Unknown,
        order: 0,
        createdAt: 1
      }
    ],
    activeSessionId: asSessionId(`${id}-s1`),
    position,
    createdAt: 1
  }
}

interface Rig {
  deps: AppDependencies
  bus: RecordingBus
  /** Accumulated ptyData for a session, exactly as the renderer's router would. */
  outputOf: (sessionId: string) => string
}

d('reconcileOnStartup over real dirs + the real PTY stack (integration, §6.3/I14)', () => {
  const tempDirs: string[] = []
  const runtimeCleanup: AppDependencies[] = []

  afterEach(() => {
    // Dispose any live runtimes started during the test so no shell lingers.
    for (const deps of runtimeCleanup.splice(0)) {
      for (const rt of deps.runtimes.all()) rt.dispose()
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function freshDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-reconcile-')))
    tempDirs.push(dir)
    return dir
  }

  function rig(snapshot: WorkspaceSnapshot): Rig {
    const bus = new RecordingBus()
    const registry = new InMemorySessionTypeRegistry()
    registry.register(new TerminalSessionTypeProvider())

    const perSession = new Map<string, string>()
    bus.subscribe((e: DomainEvent) => {
      if (e.type === 'ptyData')
        perSession.set(e.sessionId, (perSession.get(e.sessionId) ?? '') + e.data)
    })

    const deps: AppDependencies = {
      workspace: Workspace.hydrate(snapshot, { defaultSessionTypeId: 'terminal' }),
      persistence: new FakePersistence(snapshot),
      settings: new FakeSettingsStore({
        worktree: { location: '/octopus_repos' },
        terminal: { shell: '/bin/bash' },
        defaultSessionTypeId: 'terminal'
      }),
      worktrees: new FakeWorktreeProvider(),
      sessions: new PtySessionManager({ getSettings: () => deps.settings.load(), graceMs: 500 }),
      registry,
      runtimes: new MapRuntimeRegistry(),
      bus,
      ids: new SeqIdGenerator(),
      clock: new FakeClock(),
      aggregator: worstStatusWins,
      configValidator: createAjvConfigValidator(),
      socketProvisioner: new FakeSocketProvisioner(),
      scrollbacks: new RingBufferScrollbackStore(),
      currentVersion: 1
    }
    // No `onRuntimeExit` wiring: these tests never let a shell exit on its own.
    runtimeCleanup.push(deps)
    return { deps, bus, outputOf: (id) => perSession.get(id) ?? '' }
  }

  async function waitFor(
    get: () => string,
    pred: (s: string) => boolean,
    ms = 4000
  ): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred(get())) return get()
      await new Promise((r) => setTimeout(r, 20))
    }
    return get()
  }

  it('marks a task whose worktree dir was removed Stale (no runtime) and keeps the present one Ready', async () => {
    const present = freshDir()
    const removed = freshDir()
    // Simulate the worktree being deleted on disk since the last run.
    rmSync(removed, { recursive: true, force: true })
    // Drop it from the cleanup list — it's already gone.
    tempDirs.splice(tempDirs.indexOf(removed), 1)

    const r = rig({
      tasks: [taskSnapshot('t1', present, 0), taskSnapshot('t2', removed, 1)],
      activeTaskId: asTaskId('t1')
    })

    reconcileOnStartup(r.deps, { existsDir })

    expect(r.deps.workspace.task(asTaskId('t1'))!.lifecycle).toBe(TaskLifecycle.Ready)
    expect(r.deps.workspace.task(asTaskId('t2'))!.lifecycle).toBe(TaskLifecycle.Stale)
    expect(r.bus.ofType('taskStale').map((e) => e.taskId)).toEqual([asTaskId('t2')])
    // Reconciliation NEVER starts a runtime — lazy start happens on activation.
    expect(r.deps.runtimes.get(asSessionId('t1-s1'))).toBeUndefined()
    expect(r.deps.runtimes.get(asSessionId('t2-s1'))).toBeUndefined()
  })

  it('a present worktree stays Ready and switchTask spawns a fresh PTY at its cwd', async () => {
    const present = freshDir()
    const r = rig({ tasks: [taskSnapshot('t1', present, 0)], activeTaskId: asTaskId('t1') })

    reconcileOnStartup(r.deps, { existsDir })
    expect(r.deps.workspace.task(asTaskId('t1'))!.lifecycle).toBe(TaskLifecycle.Ready)
    // Still no runtime — reconciliation is lazy.
    expect(r.deps.runtimes.get(asSessionId('t1-s1'))).toBeUndefined()

    // First activation starts the restored session's fresh PTY (§6.3).
    await switchTask(r.deps, { taskId: asTaskId('t1') })

    const session = r.deps.workspace.task(asTaskId('t1'))!.session(asSessionId('t1-s1'))!
    expect(session.lifecycle).toBe(SessionLifecycle.Running)
    const runtime = r.deps.runtimes.get(asSessionId('t1-s1'))
    expect(runtime).toBeDefined()

    // Prove the shell spawned at the WORKTREE cwd by reading pwd back.
    runtime!.write('pwd\n')
    const out = await waitFor(
      () => r.outputOf('t1-s1'),
      (s) => s.includes(present)
    )
    expect(out).toContain(present)
  })
})
