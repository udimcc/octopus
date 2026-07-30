import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { ingestSessionState } from './ingest-session-state'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, type SessionId } from '../../domain/ids'
import { SessionState } from '../../domain/state'

/** Seed one ready task with a single Running session; return its ids. */
async function seedSession(): Promise<
  FakeDeps & { taskId: ReturnType<typeof asTaskId>; sessionId: SessionId }
> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  await openSession(fd.deps, { taskId })
  const sessionId = fd.workspace.task(taskId)!.sessions()[0].id
  return { ...fd, taskId, sessionId }
}

describe('ingestSessionState (§9.6, §3.4)', () => {
  it('applies the state, re-derives the task, and emits both state-changed events', async () => {
    const fd = await seedSession()

    ingestSessionState(fd.deps, { sessionId: fd.sessionId, state: SessionState.Working })

    const session = fd.workspace.task(fd.taskId)!.sessions()[0]
    expect(session.state).toBe(SessionState.Working)

    const sessionEvents = fd.bus.ofType('sessionStateChanged')
    expect(sessionEvents).toEqual([
      { type: 'sessionStateChanged', sessionId: fd.sessionId, state: SessionState.Working }
    ])
    const taskEvents = fd.bus.ofType('taskStateChanged')
    expect(taskEvents.map((e) => e.state)).toEqual([SessionState.Working])
  })

  it('records the from → to transition with clock time and meta to the state log (§11)', async () => {
    const fd = await seedSession()
    fd.clock.t = 4242

    ingestSessionState(fd.deps, {
      sessionId: fd.sessionId,
      state: SessionState.NeedsInput,
      meta: { layer: 3, confidence: 'authoritative', reason: 'claude_permission' }
    })

    expect(fd.stateLog.records).toEqual([
      {
        at: 4242,
        sessionId: fd.sessionId,
        taskId: fd.taskId,
        from: SessionState.Unknown,
        to: SessionState.NeedsInput,
        meta: { layer: 3, confidence: 'authoritative', reason: 'claude_permission' }
      }
    ])
  })

  it('captures the PRIOR state as `from` across successive transitions', async () => {
    const fd = await seedSession()

    ingestSessionState(fd.deps, { sessionId: fd.sessionId, state: SessionState.Working })
    ingestSessionState(fd.deps, { sessionId: fd.sessionId, state: SessionState.Idle })

    expect(fd.stateLog.records.map((r) => ({ from: r.from, to: r.to }))).toEqual([
      { from: SessionState.Unknown, to: SessionState.Working },
      { from: SessionState.Working, to: SessionState.Idle }
    ])
  })

  it('is a no-op for an unknown session id (no events, no log line)', async () => {
    const fd = await seedSession()

    ingestSessionState(fd.deps, {
      sessionId: 'missing' as SessionId,
      state: SessionState.Working
    })

    expect(fd.bus.ofType('sessionStateChanged')).toEqual([])
    expect(fd.stateLog.records).toEqual([])
  })
})
