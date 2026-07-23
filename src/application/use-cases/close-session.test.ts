import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { closeSession } from './close-session'
import { handleRuntimeExit } from './handle-runtime-exit'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asSessionId } from '../../domain/ids'
import { SessionLifecycle } from '../../domain/lifecycle'

async function seedWithSession(): Promise<
  FakeDeps & { taskId: ReturnType<typeof asTaskId>; sessionId: ReturnType<typeof asSessionId> }
> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  await openSession(fd.deps, { taskId })
  const sessionId = fd.workspace.task(taskId)!.sessions()[0].id
  return { ...fd, taskId, sessionId }
}

describe('closeSession — user-driven close (§3.6, §6.1)', () => {
  it('stops+disposes the runtime, removes the session, deletes the row, emits sessionClosed', async () => {
    const fd = await seedWithSession()
    const runtime = fd.sessions.last()!

    await closeSession(fd.deps, { sessionId: fd.sessionId })

    // Runtime.stop() → dispose() → dropped from registry.
    expect(runtime.stopped).toBe(true)
    expect(runtime.disposed).toBe(true)
    expect(fd.deps.runtimes.get(fd.sessionId)).toBeUndefined()

    // Session removed from the task; its row deleted.
    expect(fd.workspace.task(fd.taskId)!.sessions()).toEqual([])
    expect(fd.persistence.deletedSessions).toEqual([fd.sessionId])
    expect(fd.bus.ofType('sessionClosed').map((e) => e.sessionId)).toEqual([fd.sessionId])
    // A user close does NOT emit sessionExited.
    expect(fd.bus.ofType('sessionExited')).toEqual([])
  })

  it('is idempotent for an already-gone session', async () => {
    const { deps } = makeDeps()
    await expect(closeSession(deps, { sessionId: asSessionId('ghost') })).resolves.toBeUndefined()
  })
})

describe('handleRuntimeExit — spontaneous death (§6.1, §6.6, I13)', () => {
  it('marks the session Exited, disposes the runtime, emits sessionExited, keeps the tab', async () => {
    const fd = await seedWithSession()
    const runtime = fd.sessions.last()!

    handleRuntimeExit(fd.deps, { sessionId: fd.sessionId, exitCode: 137 })

    const session = fd.workspace.task(fd.taskId)!.session(fd.sessionId)!
    // The definition is KEPT (still a tab) but now Exited.
    expect(session.lifecycle).toBe(SessionLifecycle.Exited)
    expect(runtime.disposed).toBe(true)
    expect(fd.deps.runtimes.get(fd.sessionId)).toBeUndefined()

    const exited = fd.bus.ofType('sessionExited')
    expect(exited).toHaveLength(1)
    expect(exited[0]).toMatchObject({ sessionId: fd.sessionId, exitCode: 137 })

    // I13: no row write on exit — the persisted definition columns are unchanged.
    expect(fd.persistence.upsertedSessions.some((s) => s.id === fd.sessionId && s.lifecycle === SessionLifecycle.Exited)).toBe(false)
  })

  it('ignores a late exit for a session already Closed (no resurrection, I13)', async () => {
    const fd = await seedWithSession()
    await closeSession(fd.deps, { sessionId: fd.sessionId })
    const closedEvents = fd.bus.ofType('sessionClosed').length

    // A stale exit arrives after the user already closed the tab.
    handleRuntimeExit(fd.deps, { sessionId: fd.sessionId, exitCode: 0 })

    // The session is gone; no sessionExited emitted; nothing resurrected.
    expect(fd.workspace.task(fd.taskId)!.session(fd.sessionId)).toBeUndefined()
    expect(fd.bus.ofType('sessionExited')).toEqual([])
    expect(fd.bus.ofType('sessionClosed')).toHaveLength(closedEvents)
  })
})
