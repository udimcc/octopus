/**
 * Scrollback persistence + replay, end to end (DESIGN §6.6, §6.3 Restore). Proves
 * the whole feature over the REAL single-writer `CommandLoop`, REAL PTY stack
 * (`PtySessionManager` + terminal `SessionTypeProvider`) and the REAL in-memory
 * ring-buffer store (`RingBufferScrollbackStore`):
 *
 *   run 1: createTask → createSession → run a command with known output →
 *          simulate quit (flush every buffer to persistence) →
 *   run 2: re-bootstrap from the SAME persistence + a restored snapshot →
 *          switchTask (lazy start) → assert a ptyData event carrying the earlier
 *          output + the "session restored" marker is published, ahead of a fresh
 *          shell whose prompt still works.
 *
 * Persistence is faked (the real better-sqlite3 binary is built for Electron's ABI
 * and cannot load under host Node — see sqlite-store.test.ts), but the fake models
 * the `session_scrollback` table (save/load + ON DELETE CASCADE), so this exercises
 * the exact application flow. Everything on the runtime path is production code.
 * Skipped (not failed) when node-pty is not loadable/spawnable here.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandLoop } from '../../src/application/command-loop'
import { shutdown } from '../../src/application/quit'
import { switchTask } from '../../src/application/use-cases/switch-task'
import { MapRuntimeRegistry, type AppDependencies } from '../../src/application/dependencies'
import { createAjvConfigValidator } from '../../src/application/config-validator'
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
  FakeClock,
  taskInput
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

interface Rig {
  loop: CommandLoop
  bus: RecordingBus
  deps: AppDependencies
  outputOf: (sessionId: string) => string
}

d('scrollback persist + replay across a simulated restart (integration, §6.6/§6.3)', () => {
  const tempDirs: string[] = []
  const runtimeCleanup: AppDependencies[] = []

  afterEach(() => {
    for (const deps of runtimeCleanup.splice(0)) {
      for (const rt of deps.runtimes.all()) rt.dispose()
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function freshDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-scrollback-')))
    tempDirs.push(dir)
    return dir
  }

  /**
   * Build a rig over a given persistence + workspace. Sharing the persistence
   * across two rigs simulates the same on-disk DB surviving a restart.
   */
  function rig(persistence: FakePersistence, workspace: Workspace): Rig {
    const bus = new RecordingBus()
    const registry = new InMemorySessionTypeRegistry()
    registry.register(new TerminalSessionTypeProvider())

    const perSession = new Map<string, string>()
    bus.subscribe((e: DomainEvent) => {
      if (e.type === 'ptyData') {
        perSession.set(e.sessionId, (perSession.get(e.sessionId) ?? '') + e.data)
      }
    })

    const deps: AppDependencies = {
      workspace,
      persistence,
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
    const loop = new CommandLoop(deps)
    deps.onRuntimeExit = (sessionId, exitCode, signal): void => {
      void loop.dispatch({ kind: 'handleRuntimeExit', input: { sessionId, exitCode, signal } })
    }
    runtimeCleanup.push(deps)
    return { loop, bus, deps, outputOf: (id) => perSession.get(id) ?? '' }
  }

  /** A restored snapshot for one Ready task with one fresh Created session at `path`. */
  function restoredSnapshot(taskId: string, sessionId: string, path: string): WorkspaceSnapshot {
    return {
      tasks: [
        {
          id: asTaskId(taskId),
          name: taskId,
          worktree: {
            path,
            provisionedBy: { script: 'git', args: [taskId], repoRoot: '/repo', provisionedAt: 1 }
          },
          lifecycle: TaskLifecycle.Ready,
          state: TaskState.Unknown,
          sessions: [
            {
              id: asSessionId(sessionId),
              taskId: asTaskId(taskId),
              typeId: asTypeId('terminal'),
              title: 'Terminal 1',
              config: { kind: 'terminal' as const },
              lifecycle: SessionLifecycle.Created,
              state: SessionState.Unknown,
              order: 0,
              createdAt: 1
            }
          ],
          activeSessionId: asSessionId(sessionId),
          position: 0,
          createdAt: 1
        }
      ],
      activeTaskId: asTaskId(taskId)
    }
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

  it('replays a prior run output + separator into the restored session, ahead of a working fresh shell', async () => {
    const cwd = freshDir()
    // A persistence instance that survives the "restart" (shared across both rigs).
    const persistence = new FakePersistence()

    // ---- Run 1: create, run a command producing known output, then quit. ----
    const r1 = rig(persistence, Workspace.create({ defaultSessionTypeId: 'terminal' }))
    const worktrees1 = r1.deps.worktrees as FakeWorktreeProvider
    worktrees1.createdPath = cwd

    await r1.loop.dispatch({ kind: 'createTask', input: taskInput('alpha') })
    const taskId = asTaskId('task-1')
    await r1.loop.dispatch({ kind: 'createSession', input: { taskId } })
    const sessionId = asSessionId('session-1')

    r1.loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId, data: 'echo SCROLLBACK_MARK_$((6*9))\n' }
    })
    await waitFor(
      () => r1.outputOf(sessionId),
      (s) => /SCROLLBACK_MARK_54/.test(s)
    )
    expect(r1.deps.scrollbacks.snapshot(sessionId)).toMatch(/SCROLLBACK_MARK_54/)

    // Simulate quit: flush the buffers to persistence + checkpoint/close.
    shutdown(r1.deps)
    expect(persistence.savedScrollback.get(sessionId)).toMatch(/SCROLLBACK_MARK_54/)

    // ---- Run 2: re-bootstrap from the SAME persistence + a restored snapshot. ----
    const snapshot = restoredSnapshot('task-1', 'session-1', cwd)
    const r2 = rig(persistence, Workspace.hydrate(snapshot, { defaultSessionTypeId: 'terminal' }))

    // First activation lazily starts the restored session's fresh PTY (§6.3) and
    // replays the persisted scrollback ahead of the fresh shell's output.
    await switchTask(r2.deps, { taskId })

    const session = r2.deps.workspace.task(taskId)!.session(sessionId)!
    expect(session.lifecycle).toBe(SessionLifecycle.Running)

    // The prior run output and the restore marker were replayed into the session.
    const replayed = await waitFor(
      () => r2.outputOf(sessionId),
      (s) => s.includes('SCROLLBACK_MARK_54') && s.includes('session restored')
    )
    expect(replayed).toMatch(/SCROLLBACK_MARK_54/)
    expect(replayed).toContain('session restored')

    // The fresh shell is genuinely live: a new command still echoes back, AFTER
    // the replayed history.
    r2.loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId, data: 'echo AFTER_RESTORE\n' }
    })
    const afterOut = await waitFor(
      () => r2.outputOf(sessionId),
      (s) => s.includes('AFTER_RESTORE')
    )
    expect(afterOut).toContain('AFTER_RESTORE')
    expect(afterOut.indexOf('session restored')).toBeLessThan(afterOut.indexOf('AFTER_RESTORE'))
  })
})
