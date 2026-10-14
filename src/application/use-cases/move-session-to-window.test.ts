import { describe, it, expect, vi } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
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
    expect(
      fd.persistence.upsertedSessions.some((s) => s.id === fd.sessionId && s.windowId === win)
    ).toBe(true)

    const moved = fd.bus.ofType('sessionMovedToWindow')
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({
      sessionId: fd.sessionId,
      fromWindowId: MAIN_WINDOW_ID,
      toWindowId: win
    })
    // An explicit move (drag / "Move to") carries no cause, so the target marks it.
    expect(moved[0]).not.toHaveProperty('cause')
  })

  it('publishes the cause when an internal caller supplies one (window-close move-to-main)', async () => {
    const fd = await seedWithSession()

    moveSessionToWindow(
      fd.deps,
      { sessionId: fd.sessionId, targetWindowId: asWindowId('win-2') },
      { cause: 'windowClosed' }
    )

    expect(fd.bus.ofType('sessionMovedToWindow')).toEqual([
      {
        type: 'sessionMovedToWindow',
        sessionId: fd.sessionId,
        taskId: fd.taskId,
        fromWindowId: MAIN_WINDOW_ID,
        toWindowId: asWindowId('win-2'),
        cause: 'windowClosed'
      }
    ])
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
      moveSessionToWindow(deps, {
        sessionId: asSessionId('ghost'),
        targetWindowId: asWindowId('win-2')
      })
    ).toThrow(InvariantViolationError)
  })
})

describe('moveSessionToWindow — group moves (DESIGN §5.7 "Moving a group")', () => {
  async function seedGroupedTask(): Promise<
    FakeDeps & {
      taskId: ReturnType<typeof asTaskId>
      s1: ReturnType<typeof asSessionId>
      s2: ReturnType<typeof asSessionId>
    }
  > {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    await openSession(fd.deps, { taskId })
    const [a, b] = fd.workspace.task(taskId)!.sessions()
    joinGroup(fd.deps, { sessionId: b.id, anchorSessionId: a.id, dir: 'row' })
    return { ...fd, taskId, s1: a.id, s2: b.id }
  }

  it('moves every group member to the target window, not just the one sent', async () => {
    const fd = await seedGroupedTask()
    const win = asWindowId('win-2')

    moveSessionToWindow(fd.deps, { sessionId: fd.s1, targetWindowId: win })

    const task = fd.workspace.task(fd.taskId)!
    expect(task.session(fd.s1)!.windowId).toBe(win)
    expect(task.session(fd.s2)!.windowId).toBe(win)
    expect(fd.persistence.upsertedSessions.some((s) => s.id === fd.s1 && s.windowId === win)).toBe(
      true
    )
    expect(fd.persistence.upsertedSessions.some((s) => s.id === fd.s2 && s.windowId === win)).toBe(
      true
    )
  })

  it('marks only the directly-sent member; groupmates ride along with cause: groupMove', async () => {
    const fd = await seedGroupedTask()
    const win = asWindowId('win-2')

    moveSessionToWindow(fd.deps, { sessionId: fd.s1, targetWindowId: win })

    const moved = fd.bus.ofType('sessionMovedToWindow')
    expect(moved).toHaveLength(2)
    const sent = moved.find((e) => e.sessionId === fd.s1)!
    const rode = moved.find((e) => e.sessionId === fd.s2)!
    expect(sent).not.toHaveProperty('cause')
    expect(rode.cause).toBe('groupMove')
  })

  it('publishes the SENT member first even when it is not tab-first (review Finding 2 / U11, U11b)', async () => {
    // s1 is tab-first (the anchor); sending s2 (the groupmate) is the only way
    // to tell "sent-first" apart from "tab order" or "reversed movedIds" —
    // sending the already-tab-first member would make all three orderings
    // coincide.
    const fd = await seedGroupedTask()
    const win = asWindowId('win-2')

    moveSessionToWindow(fd.deps, { sessionId: fd.s2, targetWindowId: win })

    const moved = fd.bus.ofType('sessionMovedToWindow')
    expect(moved.map((e) => [e.sessionId, e.cause])).toEqual([
      [fd.s2, undefined],
      [fd.s1, 'groupMove']
    ])
  })

  it('tags only the directly-sent member with an internal cause; the groupmate still gets groupMove', async () => {
    const fd = await seedGroupedTask()
    const win = asWindowId('win-2')

    moveSessionToWindow(
      fd.deps,
      { sessionId: fd.s1, targetWindowId: win },
      { cause: 'windowClosed' }
    )

    const moved = fd.bus.ofType('sessionMovedToWindow')
    const sent = moved.find((e) => e.sessionId === fd.s1)!
    const rode = moved.find((e) => e.sessionId === fd.s2)!
    expect(sent.cause).toBe('windowClosed')
    expect(rode.cause).toBe('groupMove')
  })

  it('does not touch the group tree/color — only each member windowId changes, no upsertGroup call', async () => {
    const fd = await seedGroupedTask()
    const task = fd.workspace.task(fd.taskId)!
    const groupBefore = task.groupOf(fd.s1)!
    // A spy, not a size check (review Finding 11): `upsertGroup` re-writing
    // the SAME unchanged row wouldn't change the fake Map's size either.
    const spy = vi.spyOn(fd.persistence, 'upsertGroup')

    moveSessionToWindow(fd.deps, { sessionId: fd.s1, targetWindowId: asWindowId('win-2') })

    const groupAfter = task.groupOf(fd.s1)!
    expect(groupAfter.tree).toEqual(groupBefore.tree)
    expect(groupAfter.colorIndex).toBe(groupBefore.colorIndex)
    expect(spy).not.toHaveBeenCalled()
  })

  it('is idempotent when a groupmate is reprocessed into the same window it is already in', async () => {
    const fd = await seedGroupedTask()
    const win = asWindowId('win-2')
    moveSessionToWindow(fd.deps, { sessionId: fd.s1, targetWindowId: win })
    fd.bus.events.length = 0

    // A caller's loop over every hosted session (closeWindow-style) re-processes
    // the groupmate that already rode along — must be a harmless no-op.
    moveSessionToWindow(fd.deps, { sessionId: fd.s2, targetWindowId: win })

    expect(fd.bus.ofType('sessionMovedToWindow')).toEqual([])
  })
})
