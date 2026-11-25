/**
 * V1 end-to-end smoke test (DESIGN §11, the M7 "E2E smoke" gate). Headless — no
 * GUI: it drives the REAL single-writer `CommandLoop` over the REAL PTY stack
 * (`PtySessionManager` + terminal `SessionTypeProvider` + `InMemorySessionTypeRegistry`)
 * through the whole V1 user journey and asserts the guarantees a person would see:
 *
 *   createTask → createSession → writeToPty (see the command echo back) →
 *   create a 2nd task + switchTask (the 1st task's runtime STAYS registered and its
 *   accumulated output PERSISTS across the switch — the keep-alive guarantee, §5.3)
 *   → deleteTask (its sessions are disposed and `taskDeleted` fires).
 *
 * Only the worktree provider, persistence, settings, socket provisioner, ids and
 * clock are faked (reused from the application test-fakes); everything on the
 * runtime path is production code. The `FakeWorktreeProvider` means delete needs
 * no real git — it just records the `remove` request. Skipped (not failed) when
 * node-pty is not loadable/spawnable here.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandLoop } from '../../src/application/command-loop'
import { MapRuntimeRegistry, type AppDependencies } from '../../src/application/dependencies'
import { createAjvConfigValidator } from '../../src/application/config-validator'
import { Workspace } from '../../src/domain/workspace'
import { worstStatusWins } from '../../src/domain/task-state-aggregator'
import { asTaskId, asSessionId } from '../../src/domain/ids'
import { SessionLifecycle } from '../../src/domain/lifecycle'
import { PtySessionManager } from '../../src/adapters/session/pty-session-manager'
import { RingBufferScrollbackStore } from '../../src/adapters/session/scrollback-store'
import { InMemorySessionTypeRegistry } from '../../src/adapters/session-types/session-type-registry'
import { TerminalSessionTypeProvider } from '../../src/adapters/session-types/terminal-session-type-provider'
import {
  FakePersistence,
  FakeSettingsStore,
  FakeWorktreeProvider,
  RecordingBus,
  SeqIdGenerator,
  FakeClock,
  taskInput
} from '../../src/application/use-cases/test-fakes'
import type { DomainEvent } from '../../src/ports/event-bus'
import { hostProfile } from '../../src/shared/node/os/host'

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
  worktrees: FakeWorktreeProvider
  /** Accumulated ptyData per session, exactly as the renderer's router would keep. */
  outputOf: (sessionId: string) => string
}

d('V1 E2E smoke: create → run → switch (keep-alive) → delete (§11)', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function freshDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-smoke-')))
    tempDirs.push(dir)
    return dir
  }

  function rig(): Rig {
    const bus = new RecordingBus()
    const worktrees = new FakeWorktreeProvider()
    worktrees.createdPath = freshDir() // the PTY must cwd into a REAL directory
    const registry = new InMemorySessionTypeRegistry()
    registry.register(new TerminalSessionTypeProvider())

    // Accumulate ptyData per session off the bus, as the renderer's router does.
    const perSession = new Map<string, string>()
    bus.subscribe((e: DomainEvent) => {
      if (e.type === 'ptyData') {
        perSession.set(e.sessionId, (perSession.get(e.sessionId) ?? '') + e.data)
      }
    })

    const deps: AppDependencies = {
      workspace: Workspace.create({ defaultSessionTypeId: 'terminal' }),
      persistence: new FakePersistence(),
      settings: new FakeSettingsStore({
        worktree: { location: '/octopus_repos' },
        terminal: { shell: '/bin/bash' },
        defaultSessionTypeId: 'terminal',
        groupTasksByRepo: true
      }),
      worktrees,
      sessions: new PtySessionManager({
        getSettings: () => deps.settings.load(),
        graceMs: 500,
        os: hostProfile()
      }),
      registry,
      runtimes: new MapRuntimeRegistry(),
      bus,
      ids: new SeqIdGenerator(),
      clock: new FakeClock(),
      aggregator: worstStatusWins,
      configValidator: createAjvConfigValidator(),
      scrollbacks: new RingBufferScrollbackStore(),
      homeDir: '/home/test',
      currentVersion: 1
    }
    const loop = new CommandLoop(deps)
    // Route spontaneous runtime exits back through the single writer (§6.6).
    deps.onRuntimeExit = (sessionId, exitCode, signal): void => {
      void loop.dispatch({ kind: 'handleRuntimeExit', input: { sessionId, exitCode, signal } })
    }
    return { loop, bus, deps, worktrees, outputOf: (id) => perSession.get(id) ?? '' }
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

  it('runs the whole journey: output echoes, survives a task switch, and delete disposes it', async () => {
    const r = rig()

    // 1) Create the first task + a terminal session in it.
    expect((await r.loop.dispatch({ kind: 'createTask', input: taskInput('alpha') })).ok).toBe(true)
    const taskA = asTaskId('task-1')
    expect((await r.loop.dispatch({ kind: 'createSession', input: { taskId: taskA } })).ok).toBe(
      true
    )
    const sessionA = asSessionId('session-1')

    // 2) Write a command; its echoed output must surface as ptyData.
    r.loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId: sessionA, data: 'echo SMOKE_$((6*7))\n' }
    })
    await waitFor(
      () => r.outputOf(sessionA),
      (s) => /SMOKE_42/.test(s)
    )
    const outputBeforeSwitch = r.outputOf(sessionA)
    expect(outputBeforeSwitch).toMatch(/SMOKE_42/)

    // The session is Running and its runtime is registered.
    expect(r.deps.workspace.task(taskA)!.session(sessionA)!.lifecycle).toBe(
      SessionLifecycle.Running
    )
    expect(r.deps.runtimes.get(sessionA)).toBeDefined()

    // 3) Create a 2nd task and switch to it. Switching is purely visibility — the
    //    1st task's runtime keeps running and its buffer is untouched (§5.3 keep-alive).
    expect((await r.loop.dispatch({ kind: 'createTask', input: taskInput('beta') })).ok).toBe(true)
    const taskB = asTaskId('task-2')
    await r.loop.dispatch({ kind: 'switchTask', input: { taskId: taskB } })

    expect(r.deps.workspace.activeTaskId).toBe(taskB)
    // The 1st session's runtime STAYS registered across the switch.
    expect(r.deps.runtimes.get(sessionA)).toBeDefined()
    expect(r.deps.workspace.task(taskA)!.session(sessionA)!.lifecycle).toBe(
      SessionLifecycle.Running
    )
    // And its accumulated output is preserved (the backend never dropped it).
    expect(r.outputOf(sessionA)).toContain('SMOKE_42')
    expect(r.outputOf(sessionA).length).toBeGreaterThanOrEqual(outputBeforeSwitch.length)

    // The still-live shell keeps working after the switch away from it.
    r.loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId: sessionA, data: 'echo STILL_ALIVE\n' }
    })
    await waitFor(
      () => r.outputOf(sessionA),
      (s) => s.includes('STILL_ALIVE')
    )
    expect(r.outputOf(sessionA)).toContain('STILL_ALIVE')

    // 4) Delete the first task. Its runtime is disposed, its record removed, and
    //    `taskDeleted` fires. FakeWorktreeProvider records the remove (no real git).
    expect((await r.loop.dispatch({ kind: 'deleteTask', input: { taskId: taskA } })).ok).toBe(true)

    expect(r.deps.workspace.task(taskA)).toBeUndefined()
    expect(r.deps.runtimes.get(sessionA)).toBeUndefined()
    expect(r.bus.ofType('taskDeleted').map((e) => e.taskId)).toContain(taskA)
    expect(r.worktrees.removeCalls.map((c) => c.taskId)).toContain(taskA)
    // The 2nd task survives and is still the active one.
    expect(r.deps.workspace.task(taskB)).toBeDefined()
    expect(r.deps.workspace.activeTaskId).toBe(taskB)
  })
})
