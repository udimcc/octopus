import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { joinGroup } from './join-group'
import { moveSessionToWindow } from './move-session-to-window'
import { createWindow } from './create-window'
import { createView } from './create-view'
import { closeWindow } from './close-window'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId, MAIN_WINDOW_ID, type WindowId, type SessionId } from '../../domain/ids'
import { SessionLifecycle } from '../../domain/lifecycle'
import { InvariantViolationError } from '../../domain/errors'

/**
 * A task with two sessions, both moved into one freshly created secondary window —
 * the state right before that window is closed with live sessions.
 */
async function seedWindowWithTwoSessions(): Promise<
  FakeDeps & { windowId: WindowId; sessionIds: SessionId[] }
> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  await openSession(fd.deps, { taskId })
  await openSession(fd.deps, { taskId })
  const sessionIds = fd.workspace
    .task(taskId)!
    .sessions()
    .map((s) => s.id)

  const windowId = createWindow(fd.deps, { role: 'secondary' })
  for (const id of sessionIds) {
    moveSessionToWindow(fd.deps, { sessionId: id, targetWindowId: windowId })
  }
  return { ...fd, windowId, sessionIds }
}

describe('closeWindow (§3.7, §6.7)', () => {
  it('move-to-main: reassigns every hosted session back to the main window, kills nothing', async () => {
    const fd = await seedWindowWithTwoSessions()
    const runtimes = fd.sessions.created.slice()
    fd.bus.events.length = 0

    await closeWindow(fd.deps, { windowId: fd.windowId, disposition: 'move-to-main' })

    const task = fd.workspace.task(asTaskId('task-1'))!
    for (const id of fd.sessionIds) {
      const session = task.session(id)!
      // Still alive, still Running, just re-homed to the main window.
      expect(session.windowId).toBe(MAIN_WINDOW_ID)
      expect(session.lifecycle).toBe(SessionLifecycle.Running)
    }
    // No runtime was stopped/disposed.
    expect(runtimes.every((r) => !r.stopped && !r.disposed)).toBe(true)
    expect(fd.persistence.deletedSessions).toEqual([])

    // Each re-home is tagged `windowClosed` so main keeps its own marks (§6.7).
    const moves = fd.bus.ofType('sessionMovedToWindow')
    expect(moves.map((e) => e.sessionId)).toEqual(fd.sessionIds)
    for (const e of moves) {
      expect(e).toMatchObject({
        fromWindowId: fd.windowId,
        toWindowId: MAIN_WINDOW_ID,
        cause: 'windowClosed'
      })
    }

    // The window row is gone and windowClosed announced.
    expect(fd.persistence.windows.has(fd.windowId)).toBe(false)
    expect(fd.bus.ofType('windowClosed').map((e) => e.windowId)).toEqual([fd.windowId])
  })

  it('kill-sessions: closes every hosted session (teardown + row delete), then closes the window', async () => {
    const fd = await seedWindowWithTwoSessions()
    const runtimes = fd.sessions.created.slice()

    await closeWindow(fd.deps, { windowId: fd.windowId, disposition: 'kill-sessions' })

    const task = fd.workspace.task(asTaskId('task-1'))!
    // Every hosted session is removed from the task and its runtime torn down.
    for (const id of fd.sessionIds) {
      expect(task.session(id)).toBeUndefined()
    }
    expect(runtimes.every((r) => r.stopped && r.disposed)).toBe(true)
    expect(fd.persistence.deletedSessions.sort()).toEqual([...fd.sessionIds].sort())
    expect(
      fd.bus
        .ofType('sessionClosed')
        .map((e) => e.sessionId)
        .sort()
    ).toEqual([...fd.sessionIds].sort())

    expect(fd.persistence.windows.has(fd.windowId)).toBe(false)
    expect(fd.bus.ofType('windowClosed').map((e) => e.windowId)).toEqual([fd.windowId])
  })

  it('closes an empty window (no hosted sessions): just deletes the row and emits windowClosed', async () => {
    const fd = makeDeps()
    const windowId = createWindow(fd.deps, { role: 'secondary' })

    await closeWindow(fd.deps, { windowId, disposition: 'move-to-main' })

    expect(fd.persistence.windows.has(windowId)).toBe(false)
    expect(fd.bus.ofType('windowClosed').map((e) => e.windowId)).toEqual([windowId])
    expect(fd.persistence.deletedSessions).toEqual([])
  })

  it('rejects closing MAIN_WINDOW_ID — quit is the only way to close main', async () => {
    const fd = makeDeps()
    await expect(
      closeWindow(fd.deps, { windowId: MAIN_WINDOW_ID, disposition: 'move-to-main' })
    ).rejects.toThrow(InvariantViolationError)
    await expect(
      closeWindow(fd.deps, { windowId: MAIN_WINDOW_ID, disposition: 'move-to-main' })
    ).rejects.toThrow(/cannot close the main window/)
  })

  it("move-to-main on a VIEW's own secondary lands sessions back in the VIEW, not main (window-view feature)", async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    const viewResult = createView(fd.deps, { taskId })
    const viewId = viewResult.ok ? viewResult.windowId! : (undefined as never)
    const task = fd.workspace.task(taskId)!
    const viewSession = task.sessions()[0]!

    const secondaryId = createWindow(fd.deps, { role: 'secondary', parentWindowId: viewId })
    await openSession(fd.deps, { taskId, windowId: secondaryId })
    const secondarySession = task.sessions().find((s) => s.id !== viewSession.id)!
    fd.bus.events.length = 0

    await closeWindow(fd.deps, { windowId: secondaryId, disposition: 'move-to-main' })

    // The secondary's own session (and the whole move target) resolves to the
    // view's id via windowGroupRoot — NOT MAIN_WINDOW_ID.
    expect(task.session(secondarySession.id)!.windowId).toBe(viewId)
    expect(task.session(viewSession.id)!.windowId).toBe(viewId)
    const moves = fd.bus.ofType('sessionMovedToWindow')
    expect(moves.map((e) => e.toWindowId)).toEqual([viewId])
  })
})

describe('closeWindow — grouped sessions (DESIGN §5.7)', () => {
  async function seedWindowWithGroupedSessions(): Promise<
    FakeDeps & { windowId: WindowId; sessionIds: SessionId[] }
  > {
    const fd = await seedWindowWithTwoSessions()
    const [a, b] = fd.sessionIds
    joinGroup(fd.deps, { sessionId: b, anchorSessionId: a, dir: 'row' })
    return fd
  }

  it('move-to-main: the group stays intact — same tree/color, no groupsChanged published', async () => {
    const fd = await seedWindowWithGroupedSessions()
    const task = fd.workspace.task(asTaskId('task-1'))!
    const groupBefore = task.groupOf(fd.sessionIds[0])!
    fd.bus.events.length = 0

    await closeWindow(fd.deps, { windowId: fd.windowId, disposition: 'move-to-main' })

    const groupAfter = task.groupOf(fd.sessionIds[0])!
    expect(groupAfter.id).toBe(groupBefore.id)
    expect(groupAfter.tree).toEqual(groupBefore.tree)
    expect(groupAfter.colorIndex).toBe(groupBefore.colorIndex)
    for (const id of fd.sessionIds) {
      expect(task.session(id)!.windowId).toBe(MAIN_WINDOW_ID)
    }
    // The loop's FIRST moveSessionToWindow call (for sessionIds[0]) already
    // drags the whole group to main and publishes BOTH members' moves (the
    // sent one tagged windowClosed, the groupmate tagged groupMove); the
    // loop's SECOND call, reaching the groupmate directly, is the true no-op
    // (idempotent same-window guard) and publishes nothing further (review
    // Finding 12 — the previous comment here had this backwards).
    const moves = fd.bus.ofType('sessionMovedToWindow')
    expect(moves.map((e) => [e.sessionId, e.cause])).toEqual([
      [fd.sessionIds[0], 'windowClosed'],
      [fd.sessionIds[1], 'groupMove']
    ])
    // No groupsChanged either way: the group's own tree/color never changes.
    expect(fd.bus.ofType('groupsChanged')).toEqual([])
  })

  it('kill-sessions: killing every hosted session removes the group entirely', async () => {
    const fd = await seedWindowWithGroupedSessions()
    const task = fd.workspace.task(asTaskId('task-1'))!
    const groupId = task.groupOf(fd.sessionIds[0])!.id
    // `seedWindowWithGroupedSessions`'s own `joinGroup` call already published
    // a groupsChanged — clear it so the count below reflects only what
    // `closeWindow` itself publishes.
    fd.bus.events.length = 0

    await closeWindow(fd.deps, { windowId: fd.windowId, disposition: 'kill-sessions' })

    expect(task.groups()).toEqual([])
    expect(fd.persistence.groups.has(groupId)).toBe(false)
    // closeSession publishes groupsChanged once: removing the FIRST member
    // dissolves the 2-member group immediately (leave at 1 member), so the
    // second closeSession call has no group left to touch and publishes no
    // further groupsChanged (review Finding 12: `toBeGreaterThan(0)` would
    // also pass if it were spuriously published twice).
    expect(fd.bus.ofType('groupsChanged').length).toBe(1)
  })
})
