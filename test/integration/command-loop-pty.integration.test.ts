/**
 * The M4 gate, end to end (DESIGN §6.6, §6.1): drive the REAL single-writer
 * `CommandLoop` over the REAL PTY stack — `PtySessionManager` + the terminal
 * `SessionTypeProvider` + `InMemorySessionTypeRegistry` — and assert the full
 * flow the milestone calls for: `createTask → createSession → writeToPty →
 * observe ptyData`. Only the worktree provider, persistence, settings, socket
 * provisioner, ids and clock are faked (reused from the application test-fakes);
 * everything on the runtime path is production code.
 *
 * This is the headless proof that the backend is feature-complete before any UI
 * exists. It also exercises the spontaneous-exit route: a shell that exits on its
 * own must come back through the loop as `handleRuntimeExit` → `sessionExited`.
 *
 * Skipped (not failed) when node-pty is not loadable/spawnable here.
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
import type { EventDTO } from '../../src/shared/events'
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
  ptyData: () => string
}

d('CommandLoop over the real PTY stack (integration, §6.6/§6.1)', () => {
  let cwd = ''

  afterEach(() => {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true })
      cwd = ''
    }
  })

  function rig(): Rig {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-e2e-')))
    const bus = new RecordingBus()
    const worktrees = new FakeWorktreeProvider()
    worktrees.createdPath = cwd // the PTY must cwd into a REAL directory
    const persistence = new FakePersistence()
    const registry = new InMemorySessionTypeRegistry()
    registry.register(new TerminalSessionTypeProvider())

    // Accumulate ptyData off the bus, exactly as the renderer's pty-router would.
    let buf = ''
    bus.subscribe((e: DomainEvent) => {
      if (e.type === 'ptyData') buf += e.data
    })

    const deps: AppDependencies = {
      workspace: Workspace.create({ defaultSessionTypeId: 'terminal' }),
      persistence,
      settings: new FakeSettingsStore({
        worktree: { location: '/octopus_repos' },
        terminal: { shell: '/bin/bash' },
        defaultSessionTypeId: 'terminal'
      }),
      worktrees,
      sessions: new PtySessionManager({ getSettings: () => deps.settings.load(), graceMs: 500 }),
      registry,
      runtimes: new MapRuntimeRegistry(),
      bus,
      ids: new SeqIdGenerator(),
      clock: new FakeClock(),
      aggregator: worstStatusWins,
      configValidator: createAjvConfigValidator(),
      socketProvisioner: new FakeSocketProvisioner(),
      currentVersion: 1
    }
    const loop = new CommandLoop(deps)
    // Route spontaneous runtime exits back through the single writer (§6.6),
    // exactly as the composition root wires it.
    deps.onRuntimeExit = (sessionId, exitCode, signal): void => {
      void loop.dispatch({ kind: 'handleRuntimeExit', input: { sessionId, exitCode, signal } })
    }
    return { loop, bus, deps, ptyData: () => buf }
  }

  async function waitFor(get: () => string, pred: (s: string) => boolean, ms = 4000): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred(get())) return get()
      await new Promise((r) => setTimeout(r, 20))
    }
    return get()
  }

  it('createTask → createSession → writeToPty surfaces command output as ptyData', async () => {
    const r = rig()

    const created = await r.loop.dispatch({ kind: 'createTask', input: taskInput('alpha') })
    expect(created.ok).toBe(true)
    const taskId = asTaskId('task-1')

    const opened = await r.loop.dispatch({ kind: 'createSession', input: { taskId } })
    expect(opened.ok).toBe(true)
    const sessionId = asSessionId('session-1')

    // Write a command through the loop; its echoed output must arrive as ptyData.
    r.loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId, data: 'echo OCTOPUS_E2E_$((3*14))\n' }
    })
    const out = await waitFor(r.ptyData, (s) => /OCTOPUS_E2E_42/.test(s))
    expect(out).toMatch(/OCTOPUS_E2E_42/)

    // A ptyData event was actually emitted on the bus for this session.
    const ptyEvents = r.bus.ofType('ptyData')
    expect(ptyEvents.length).toBeGreaterThan(0)
    expect(ptyEvents.every((e) => e.sessionId === sessionId)).toBe(true)

    // The session is Running and its runtime is registered.
    const session = r.deps.workspace.task(taskId)!.session(sessionId)!
    expect(session.lifecycle).toBe(SessionLifecycle.Running)
    expect(r.deps.runtimes.get(sessionId)).toBeDefined()
  })

  it('a shell that exits on its own routes back through the loop as sessionExited', async () => {
    const r = rig()
    await r.loop.dispatch({ kind: 'createTask', input: taskInput('beta') })
    const taskId = asTaskId('task-1')
    await r.loop.dispatch({ kind: 'createSession', input: { taskId } })
    const sessionId = asSessionId('session-1')

    r.loop.dispatch({ kind: 'writeToPty', input: { sessionId, data: 'exit 0\n' } })

    // handleRuntimeExit runs on the loop; poll the bus for the sessionExited event.
    await waitFor(
      () => (r.bus.ofType('sessionExited').length ? 'yes' : ''),
      (s) => s === 'yes'
    )
    const exited = r.bus.ofType('sessionExited')
    expect(exited).toHaveLength(1)
    expect(exited[0].sessionId).toBe(sessionId)

    // The session is now Exited (kept as a tab) and its runtime dropped.
    const session = r.deps.workspace.task(taskId)!.session(sessionId)!
    expect(session.lifecycle).toBe(SessionLifecycle.Exited)
    expect(r.deps.runtimes.get(sessionId)).toBeUndefined()
  })

  it('closeSession stops the runtime and removes the tab (no sessionExited)', async () => {
    const r = rig()
    await r.loop.dispatch({ kind: 'createTask', input: taskInput('gamma') })
    const taskId = asTaskId('task-1')
    await r.loop.dispatch({ kind: 'createSession', input: { taskId } })
    const sessionId = asSessionId('session-1')

    const closed = await r.loop.dispatch({ kind: 'closeSession', input: { sessionId } })
    expect(closed.ok).toBe(true)

    // Give any (suppressed) exit a chance to (not) fire.
    await new Promise((res) => setTimeout(res, 100))

    expect(r.deps.workspace.task(taskId)!.session(sessionId)).toBeUndefined()
    expect(r.deps.runtimes.get(sessionId)).toBeUndefined()
    // User close ⇒ sessionClosed, and the stop-driven exit is suppressed.
    expect(r.bus.ofType('sessionClosed').map((e) => e.sessionId)).toEqual([sessionId])
    expect(r.bus.ofType('sessionExited')).toEqual([])
  })

  // Keep the EventDTO import meaningful: ptyData maps to a wire DTO with the same
  // shape (asserted structurally here to tie the integration to the wire contract).
  it('ptyData events are shaped like their wire EventDTO', async () => {
    const r = rig()
    await r.loop.dispatch({ kind: 'createTask', input: taskInput('delta') })
    await r.loop.dispatch({ kind: 'createSession', input: { taskId: asTaskId('task-1') } })
    r.loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId: asSessionId('session-1'), data: 'echo HI\n' }
    })
    await waitFor(r.ptyData, (s) => s.includes('HI'))
    const [evt] = r.bus.ofType('ptyData')
    const wire: EventDTO = { type: 'ptyData', sessionId: evt.sessionId, data: evt.data }
    expect(wire.type).toBe('ptyData')
    expect(typeof wire.sessionId).toBe('string')
    expect(typeof wire.data).toBe('string')
  })
})
