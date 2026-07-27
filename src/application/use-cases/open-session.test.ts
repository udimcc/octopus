import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asSessionId, asWindowId, MAIN_WINDOW_ID } from '../../domain/ids'
import { SessionLifecycle } from '../../domain/lifecycle'
import { InvariantViolationError } from '../../domain/errors'

async function seedReadyTask(): Promise<FakeDeps & { taskId: ReturnType<typeof asTaskId> }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  return { ...fd, taskId: asTaskId('task-1') }
}

describe('openSession happy path (§3.6, §6.1)', () => {
  it('creates a Running session, registers the runtime, persists, and emits sessionCreated', async () => {
    const fd = await seedReadyTask()

    await openSession(fd.deps, { taskId: fd.taskId })

    const task = fd.workspace.task(fd.taskId)!
    const sessions = task.sessions()
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    expect(session.lifecycle).toBe(SessionLifecycle.Running)
    expect(session.title).toBe('Terminal 1')

    // The runtime was started and registered under the session id.
    const runtime = fd.sessions.last()!
    expect(runtime.started).toBe(true)
    expect(fd.deps.runtimes.get(session.id)).toBe(runtime)

    // Context: cwd = worktree, default 80×24, dormant state socket path wired.
    expect(runtime.ctx.worktreePath).toBe('/wt/task')
    expect(runtime.ctx.cols).toBe(80)
    expect(runtime.ctx.rows).toBe(24)
    expect(runtime.ctx.stateSocketPath).toBe(`/tmp/octopus-test/session-${session.id}.sock`)

    // Persisted the session + task in one transaction; sessionCreated announced.
    const createTaskTx = 1
    expect(fd.persistence.transactions).toBe(createTaskTx + 1)
    expect(fd.persistence.upsertedSessions.map((s) => s.id)).toEqual([session.id])
    expect(fd.bus.ofType('sessionCreated').map((e) => e.session.id)).toEqual([session.id])
  })

  it('routes runtime output to a ptyData event and spontaneous exit to onRuntimeExit', async () => {
    const fd = await seedReadyTask()
    const exitCalls: Array<{ id: string; code?: number }> = []
    fd.deps.onRuntimeExit = (id, code) => exitCalls.push({ id, code })

    await openSession(fd.deps, { taskId: fd.taskId })
    const session = fd.workspace.task(fd.taskId)!.sessions()[0]
    const runtime = fd.sessions.last()!

    runtime.ctx.onData('hello')
    expect(fd.bus.ofType('ptyData')).toEqual([
      { type: 'ptyData', sessionId: session.id, data: 'hello' }
    ])
    // The same chunk is captured for scrollback persistence (§6.6).
    expect(fd.scrollbacks.snapshot(session.id)).toBe('hello')

    runtime.ctx.onExit(0, undefined)
    expect(exitCalls).toEqual([{ id: session.id, code: 0 }])
  })
})

describe('openSession validation failure (§3.6, §10 ajv seam)', () => {
  it('rejects an ill-formed config pre-create: no session, no runtime, error event', async () => {
    const fd = await seedReadyTask()

    await expect(
      // `bogus` violates additionalProperties:false in the terminal schema.
      openSession(fd.deps, {
        taskId: fd.taskId,
        config: { kind: 'terminal', bogus: 1 } as never
      })
    ).rejects.toThrow(InvariantViolationError)

    expect(fd.workspace.task(fd.taskId)!.sessions()).toEqual([])
    expect(fd.sessions.created).toEqual([]) // no runtime ever created
    expect(fd.bus.ofType('error')).toHaveLength(1)
    expect(fd.bus.ofType('sessionCreated')).toEqual([])
  })
})

describe('openSession runtime start failure (§3.6)', () => {
  it('marks StartFailed, disposes, and does NOT add or persist the session', async () => {
    const fd = await seedReadyTask()
    fd.sessions.failNextStartWith = new Error('spawn ENOENT')

    await expect(openSession(fd.deps, { taskId: fd.taskId })).rejects.toThrow(/spawn ENOENT/)

    // A brand-new session that never ran is discarded.
    expect(fd.workspace.task(fd.taskId)!.sessions()).toEqual([])
    const runtime = fd.sessions.last()!
    expect(runtime.disposed).toBe(true)
    expect(fd.deps.runtimes.all()).toEqual([])
    expect(fd.persistence.upsertedSessions).toEqual([])
    // start-session-runtime emits an error event on failure.
    expect(fd.bus.ofType('error')).toHaveLength(1)
    expect(fd.bus.ofType('sessionCreated')).toEqual([])
  })
})

describe('openSession window hosting (V1.5, §6.7)', () => {
  it('hosts the session in the requested window — persisted and on sessionCreated', async () => {
    const fd = await seedReadyTask()

    await openSession(fd.deps, { taskId: fd.taskId, windowId: asWindowId('win-2') })

    const session = fd.workspace.task(fd.taskId)!.sessions()[0]
    expect(session.windowId).toBe('win-2')
    // The assignment is stamped BEFORE persist + emit, so both carry it.
    expect(fd.persistence.upsertedSessions.map((s) => s.windowId)).toEqual(['win-2'])
    expect(fd.bus.ofType('sessionCreated').map((e) => e.session.windowId)).toEqual(['win-2'])
  })

  it('defaults to the main window when no windowId is given', async () => {
    const fd = await seedReadyTask()

    await openSession(fd.deps, { taskId: fd.taskId })

    const session = fd.workspace.task(fd.taskId)!.sessions()[0]
    expect(session.windowId).toBe(MAIN_WINDOW_ID)
  })
})

describe('openSession guards', () => {
  it('throws when the task does not exist', async () => {
    const { deps } = makeDeps()
    await expect(openSession(deps, { taskId: asTaskId('ghost') })).rejects.toThrow(
      InvariantViolationError
    )
  })

  it('throws for an unknown session type', async () => {
    const fd = await seedReadyTask()
    await expect(
      openSession(fd.deps, { taskId: fd.taskId, typeId: asSessionId('nope') as never })
    ).rejects.toThrow(/unknown session type/)
  })
})
