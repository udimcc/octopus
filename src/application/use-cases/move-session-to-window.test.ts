import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { moveSessionToWindow } from './move-session-to-window'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, asSessionId, asWindowId, MAIN_WINDOW_ID } from '../../domain/ids'
import { SessionLifecycle } from '../../domain/lifecycle'
import { InvariantViolationError } from '../../domain/errors'

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

describe('moveSessionToWindow (§3.7, §6.7, I18)', () => {
  it('reassigns windowId, persists the row, and emits sessionMovedToWindow with both endpoints', async () => {
    const fd = await seedWithSession()
    const win = asWindowId('win-2')

    moveSessionToWindow(fd.deps, { sessionId: fd.sessionId, targetWindowId: win })

    const session = fd.workspace.task(fd.taskId)!.session(fd.sessionId)!
    expect(session.windowId).toBe(win)
    // The assignment is persisted so it survives a restart (§6.3).
    expect(fd.persistence.upsertedSessions.some((s) => s.id === fd.sessionId && s.windowId === win)).toBe(true)

    const moved = fd.bus.ofType('sessionMovedToWindow')
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({
      sessionId: fd.sessionId,
      fromWindowId: MAIN_WINDOW_ID,
      toWindowId: win
    })
  })

  it('leaves taskId and lifecycle untouched — a move is a pure view re-assignment, not a restart (I7/I18)', async () => {
    const fd = await seedWithSession()
    const before = fd.workspace.task(fd.taskId)!.session(fd.sessionId)!
    const runtime = fd.sessions.last()!

    moveSessionToWindow(fd.deps, { sessionId: fd.sessionId, targetWindowId: asWindowId('win-2') })

    const after = fd.workspace.task(fd.taskId)!.session(fd.sessionId)!
    // Same task, still Running; the PTY was never stopped/restarted.
    expect(after.taskId).toBe(before.taskId)
    expect(after.lifecycle).toBe(SessionLifecycle.Running)
    expect(runtime.stopped).toBe(false)
    expect(runtime.disposed).toBe(false)
    // No new runtime spun up for the move.
    expect(fd.sessions.created).toHaveLength(1)
  })

  it('is a no-op when the session is already in the target window (idempotent drop)', async () => {
    const fd = await seedWithSession()
    // openSession already persisted the session once; a same-window move must add
    // no further upsert and emit no event.
    const upsertsBefore = fd.persistence.upsertedSessions.length

    // The session starts in the main window; moving it there again changes nothing.
    moveSessionToWindow(fd.deps, { sessionId: fd.sessionId, targetWindowId: MAIN_WINDOW_ID })

    expect(fd.persistence.upsertedSessions.length).toBe(upsertsBefore)
    expect(fd.bus.ofType('sessionMovedToWindow')).toEqual([])
  })

  it('throws for an unknown session', () => {
    const { deps } = makeDeps()
    expect(() =>
      moveSessionToWindow(deps, { sessionId: asSessionId('ghost'), targetWindowId: asWindowId('win-2') })
    ).toThrow(InvariantViolationError)
  })
})
