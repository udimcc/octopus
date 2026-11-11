import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { closeSession } from './close-session'
import { joinGroup } from './join-group'
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

  it('announces the recomputed task state after removing the session (§3.4, §6.6)', async () => {
    const fd = await seedWithSession()

    await closeSession(fd.deps, { sessionId: fd.sessionId })

    // The last session is gone → the task rolls up to Unknown; a taskStateChanged
    // keeps late-joining windows consistent even though the store also recomputes.
    const taskEvents = fd.bus.ofType('taskStateChanged')
    expect(taskEvents.length).toBeGreaterThanOrEqual(1)
    expect(taskEvents.at(-1)).toMatchObject({ taskId: fd.taskId })
  })

  it('frees the in-memory scrollback buffer on close; the persisted row cascades away (§6.6)', async () => {
    const fd = await seedWithSession()
    // Simulate captured output, and a persisted row from a prior flush.
    fd.deps.scrollbacks.append(fd.sessionId, 'some output')
    fd.persistence.saveScrollback(fd.sessionId, 'some output')

    await closeSession(fd.deps, { sessionId: fd.sessionId })

    // In-memory buffer freed immediately.
    expect(fd.scrollbacks.snapshot(fd.sessionId)).toBeUndefined()
    // The DB row is purged by ON DELETE CASCADE when the session row is deleted
    // (the fake persistence models the cascade); no explicit scrollback delete.
    expect(fd.persistence.savedScrollback.has(fd.sessionId)).toBe(false)
  })

  it('is idempotent for an already-gone session', async () => {
    const { deps } = makeDeps()
    await expect(closeSession(deps, { sessionId: asSessionId('ghost') })).resolves.toBeUndefined()
  })
})

describe('closeSession — grouped sessions (DESIGN §5.7)', () => {
  async function seedGroupOfThree(): Promise<
    FakeDeps & { taskId: ReturnType<typeof asTaskId>; sessionIds: ReturnType<typeof asSessionId>[] }
  > {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    await openSession(fd.deps, { taskId })
    await openSession(fd.deps, { taskId })
    const [s1, s2, s3] = fd.workspace.task(taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    joinGroup(fd.deps, { sessionId: s3.id, anchorSessionId: s2.id, dir: 'col' })
    return { ...fd, taskId, sessionIds: [s1.id, s2.id, s3.id] }
  }

  it('closing one member of a 3+ group just drops its leaf — the group survives', async () => {
    const fd = await seedGroupOfThree()
    const [s1, s2, s3] = fd.sessionIds
    const task = fd.workspace.task(fd.taskId)!
    const groupId = task.groupOf(s1)!.id
    fd.bus.events.length = 0

    await closeSession(fd.deps, { sessionId: s3 })

    const group = task.groupOf(s1)!
    expect(group.id).toBe(groupId)
    expect(task.groups()).toHaveLength(1)
    expect(task.groupMembers(s1).sort()).toEqual([s1, s2].sort())
    expect(fd.persistence.groups.get(groupId)?.group.tree).toEqual(group.tree)
  })

  it('closing one member of a 2-member group dissolves it entirely', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    await openSession(fd.deps, { taskId })
    const [s1, s2] = fd.workspace.task(taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: s2.id, anchorSessionId: s1.id, dir: 'row' })
    const task = fd.workspace.task(taskId)!
    const groupId = task.groupOf(s1.id)!.id
    fd.bus.events.length = 0

    await closeSession(fd.deps, { sessionId: s2.id })

    expect(task.groups()).toEqual([])
    expect(task.groupOf(s1.id)).toBeUndefined()
    expect(fd.persistence.groups.has(groupId)).toBe(false)
  })

  it('publishes sessionClosed, then groupsChanged, then taskStateChanged for a grouped close', async () => {
    const fd = await seedGroupOfThree()
    const [, , s3] = fd.sessionIds
    fd.bus.events.length = 0

    await closeSession(fd.deps, { sessionId: s3 })

    expect(fd.bus.events.map((e) => e.type)).toEqual([
      'sessionClosed',
      'groupsChanged',
      'taskStateChanged'
    ])
  })

  it('does NOT publish groupsChanged when closing a lone (ungrouped) session', async () => {
    const fd = await seedWithSession()
    fd.bus.events.length = 0

    await closeSession(fd.deps, { sessionId: fd.sessionId })

    expect(fd.bus.events.map((e) => e.type)).toEqual(['sessionClosed', 'taskStateChanged'])
    expect(fd.bus.ofType('groupsChanged')).toEqual([])
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

    // An exit aggregates as NeedsInput → the task rollup is announced (§3.4).
    const taskEvents = fd.bus.ofType('taskStateChanged')
    expect(taskEvents).toHaveLength(1)
    expect(taskEvents[0]).toMatchObject({ taskId: fd.taskId, state: 'blocked' })

    // I13: no row write on exit — the persisted definition columns are unchanged.
    expect(
      fd.persistence.upsertedSessions.some(
        (s) => s.id === fd.sessionId && s.lifecycle === SessionLifecycle.Exited
      )
    ).toBe(false)
  })

  it('persists the captured scrollback before dispose and KEEPS the in-memory buffer (§6.6)', async () => {
    const fd = await seedWithSession()
    fd.deps.scrollbacks.append(fd.sessionId, 'final output')

    handleRuntimeExit(fd.deps, { sessionId: fd.sessionId, exitCode: 0 })

    // The exited session keeps its row, so its final output is persisted for restart.
    expect(fd.persistence.savedScrollback.get(fd.sessionId)?.live).toBe('final output')
    // Unlike a user close, the in-memory buffer is NOT freed (the session persists),
    // but it is clean: the periodic flush must not rewrite it.
    expect(fd.scrollbacks.snapshot(fd.sessionId)).toBe('final output')
    expect([...fd.scrollbacks.dirtyEntries()]).toEqual([])
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
