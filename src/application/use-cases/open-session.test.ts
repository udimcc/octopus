import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { closeSession } from './close-session'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { createView } from './create-view'
import { createWindow } from './create-window'
import { asTaskId, asSessionId, asWindowId, MAIN_WINDOW_ID } from '../../domain/ids'
import { SessionLifecycle } from '../../domain/lifecycle'
import { InvariantViolationError } from '../../domain/errors'

async function seedReadyTask(): Promise<FakeDeps & { taskId: ReturnType<typeof asTaskId> }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  return { ...fd, taskId: asTaskId('task-1') }
}

async function seedNoRepoTask(): Promise<FakeDeps & { taskId: ReturnType<typeof asTaskId> }> {
  const fd = makeDeps()
  await createTask(fd.deps, { mode: 'none', name: 'Scratch' })
  return { ...fd, taskId: asTaskId('task-1') }
}

/**
 * The persisted (last-upserted) order of every live session matches the
 * task's current order — stronger than "every id appears somewhere".
 */
function expectRowsMatch(
  fd: FakeDeps,
  task: { sessions(): readonly { id: unknown; order: number }[] }
) {
  const last = new Map<unknown, number>()
  for (const s of fd.persistence.upsertedSessions) last.set(s.id, s.order)
  const live = task.sessions().map((s) => [s.id, s.order] as const)
  expect(live.every(([id, order]) => last.get(id) === order)).toBe(true)
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

    // Context: cwd = worktree, default 80×24.
    expect(runtime.ctx.worktreePath).toBe('/wt/task')
    expect(runtime.ctx.cols).toBe(80)
    expect(runtime.ctx.rows).toBe(24)

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

describe('openSession on a "No Repo" task (§5.4)', () => {
  it('opens at the home dir with no cwdOverride — no worktree needed', async () => {
    const fd = await seedNoRepoTask()

    await openSession(fd.deps, { taskId: fd.taskId })

    const session = fd.workspace.task(fd.taskId)!.sessions()[0]
    expect(session.lifecycle).toBe(SessionLifecycle.Running)
    // No worktree → defaultConfig carries no cwdOverride → runtime lands at homeDir.
    expect(session.config).toEqual({ kind: 'terminal' })
    expect(fd.sessions.last()!.ctx.worktreePath).toBe('/home/test')
  })
})

describe('openSession auto-naming (§6.1)', () => {
  it('numbers sequentially by max-in-use + 1, not by session count (no reuse after a close)', async () => {
    const fd = await seedReadyTask()

    await openSession(fd.deps, { taskId: fd.taskId }) // Terminal 1
    await openSession(fd.deps, { taskId: fd.taskId }) // Terminal 2
    const task = fd.workspace.task(fd.taskId)!
    expect(task.sessions().map((s) => s.title)).toEqual(['Terminal 1', 'Terminal 2'])

    // Close "Terminal 1": the array shrinks back to one session.
    const terminal1 = task.sessions().find((s) => s.title === 'Terminal 1')!
    await closeSession(fd.deps, { sessionId: terminal1.id })
    expect(task.sessions().map((s) => s.title)).toEqual(['Terminal 2'])

    // The next session must be "Terminal 3" (max-in-use 2 + 1), NOT "Terminal 2"
    // again — count + 1 would have collided (the original bug).
    await openSession(fd.deps, { taskId: fd.taskId })
    expect(
      task
        .sessions()
        .map((s) => s.title)
        .sort()
    ).toEqual(['Terminal 2', 'Terminal 3'])
  })

  it('honors an explicit title over the auto-generated one', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId, title: 'my shell' })
    expect(fd.workspace.task(fd.taskId)!.sessions()[0].title).toBe('my shell')
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

describe('openSession split intent (§5.7)', () => {
  it('joins the new session into the anchor group in the same command: sessionCreated, then groupsChanged, then sessionReordered', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId }) // anchor: Terminal 1
    const task = fd.workspace.task(fd.taskId)!
    const anchor = task.sessions()[0]
    fd.bus.events.length = 0

    await openSession(fd.deps, {
      taskId: fd.taskId,
      split: { anchorSessionId: anchor.id, dir: 'row' }
    })

    const sessions = task.sessions()
    expect(sessions).toHaveLength(2)
    const newSession = sessions.find((s) => s.id !== anchor.id)!
    expect(task.groupOf(anchor.id)?.id).toBe(task.groupOf(newSession.id)?.id)
    expect(task.groupMembers(anchor.id)).toEqual([anchor.id, newSession.id])

    expect(fd.bus.events.map((e) => e.type)).toEqual([
      'sessionCreated',
      'groupsChanged',
      'sessionReordered'
    ])
    // Both session rows persisted (new tab moved next to the anchor's),
    // exact last-written order per id — not just "was written at some
    // point" (review Finding 1).
    expectRowsMatch(fd, task)
    // The full resulting order is published, not just the new session's id
    // (review U7/U8).
    const reordered = fd.bus.ofType('sessionReordered')[0]!
    expect(reordered.orderedSessionIds).toEqual(task.sessions().map((s) => s.id))
    expect(fd.persistence.groups.size).toBe(1)
  })

  it('persists a THIRD, uninvolved session whose order shifted as a side effect of the join (review U7b)', async () => {
    // The happy-path test above has only 2 sessions, so the newly-created one's
    // own row is the ONLY row whose order changes — a mutant that persists just
    // `session` (the new one) instead of looping over `ordered` would still pass
    // it. Seed a THIRD, uninvolved session so that moving the new session's tab
    // next to the anchor's pushes it one slot over, forcing ITS row to be
    // re-persisted too.
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId }) // anchor, order 0
    const task = fd.workspace.task(fd.taskId)!
    const anchor = task.sessions()[0]
    await openSession(fd.deps, { taskId: fd.taskId }) // uninvolved, order 1
    const uninvolved = task.sessions()[1]
    fd.bus.events.length = 0

    await openSession(fd.deps, {
      taskId: fd.taskId,
      split: { anchorSessionId: anchor.id, dir: 'row' }
    })

    const sessions = task.sessions()
    expect(sessions).toHaveLength(3)
    // The new session landed right after the anchor, pushing the uninvolved
    // session from order 1 to order 2.
    expect(task.session(uninvolved.id)!.order).toBe(2)
    expectRowsMatch(fd, task)
  })

  it('forms a brand-new group when the anchor was lone, in the requested dir', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId })
    const task = fd.workspace.task(fd.taskId)!
    const anchor = task.sessions()[0]
    expect(task.groupOf(anchor.id)).toBeUndefined()

    await openSession(fd.deps, {
      taskId: fd.taskId,
      split: { anchorSessionId: anchor.id, dir: 'col' }
    })

    expect(task.groupOf(anchor.id)).toBeDefined()
    expect(task.groups()).toHaveLength(1)
    // The requested 'col' direction must actually reach `task.join` — a
    // mutant that hardcodes 'row' would be invisible to a test that only
    // checks group membership (review U10b).
    expect(task.groupOf(anchor.id)!.tree).toMatchObject({ dir: 'col' })
  })

  it('drops the split silently and creates a lone session for an unknown anchor', async () => {
    const fd = await seedReadyTask()
    fd.bus.events.length = 0

    await openSession(fd.deps, {
      taskId: fd.taskId,
      split: { anchorSessionId: asSessionId('ghost'), dir: 'row' }
    })

    const task = fd.workspace.task(fd.taskId)!
    expect(task.sessions()).toHaveLength(1)
    expect(task.groups()).toEqual([])
    // Only sessionCreated — no group events for a dropped split.
    expect(fd.bus.events.map((e) => e.type)).toEqual(['sessionCreated'])
  })

  it('drops the split silently when the anchor belongs to a different task', async () => {
    const fd = await seedReadyTask()
    await createTask(fd.deps, taskInput('other'))
    const otherTaskId = asTaskId('task-2')
    await openSession(fd.deps, { taskId: otherTaskId })
    const otherAnchor = fd.workspace.task(otherTaskId)!.sessions()[0]

    await openSession(fd.deps, {
      taskId: fd.taskId,
      split: { anchorSessionId: otherAnchor.id, dir: 'row' }
    })

    const task = fd.workspace.task(fd.taskId)!
    expect(task.sessions()).toHaveLength(1)
    expect(task.groups()).toEqual([])
  })

  it('drops the split silently when the anchor is hosted in a different window (raced mark)', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId, windowId: asWindowId('win-2') })
    const task = fd.workspace.task(fd.taskId)!
    const anchor = task.sessions()[0]
    fd.bus.events.length = 0

    // New session defaults to the main window; the anchor is in win-2.
    await openSession(fd.deps, {
      taskId: fd.taskId,
      split: { anchorSessionId: anchor.id, dir: 'row' }
    })

    expect(task.sessions()).toHaveLength(2)
    expect(task.groups()).toEqual([])
    expect(fd.bus.events.map((e) => e.type)).toEqual(['sessionCreated'])
  })
})

describe('openSession plain create tab order (§6.1, review C1)', () => {
  it('lands a new plain session at the tail, not in a gap left by a closed one', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId }) // Terminal 1, order 0
    await openSession(fd.deps, { taskId: fd.taskId }) // Terminal 2, order 1
    await openSession(fd.deps, { taskId: fd.taskId }) // Terminal 3, order 2
    const task = fd.workspace.task(fd.taskId)!
    const terminal1 = task.sessions().find((s) => s.title === 'Terminal 1')!
    await closeSession(fd.deps, { sessionId: terminal1.id }) // frees order 0
    const maxOrderBeforeNew = Math.max(...task.sessions().map((s) => s.order))

    await openSession(fd.deps, { taskId: fd.taskId })

    const newSession = task.sessions().find((s) => s.title === 'Terminal 4')!
    // Lands strictly after the current tail, not back-filled into the gap at 0.
    expect(newSession.order).toBe(maxOrderBeforeNew + 1)
  })
})

describe('openSession window-view group refusal (window-view feature)', () => {
  it("refuses a request from outside the task's own view group once the task has a view", async () => {
    const fd = await seedReadyTask()
    const viewResult = createView(fd.deps, { taskId: fd.taskId })
    expect(viewResult.ok).toBe(true)

    // Defaults to MAIN_WINDOW_ID when no windowId is given — outside the view's group.
    await expect(openSession(fd.deps, { taskId: fd.taskId })).rejects.toThrow(
      InvariantViolationError
    )
    await expect(openSession(fd.deps, { taskId: fd.taskId })).rejects.toThrow(
      /dedicated view window/
    )
  })

  it("still allows opening a session FROM the task's own view (and its secondaries)", async () => {
    const fd = await seedReadyTask()
    const viewResult = createView(fd.deps, { taskId: fd.taskId })
    const viewId = viewResult.ok ? viewResult.windowId! : (undefined as never)

    await expect(openSession(fd.deps, { taskId: fd.taskId, windowId: viewId })).resolves.toEqual(
      expect.any(String)
    )
    const task = fd.workspace.task(fd.taskId)!
    expect(task.sessions().some((s) => s.windowId === viewId)).toBe(true)

    const secondaryId = createWindow(fd.deps, { role: 'secondary', parentWindowId: viewId })
    await expect(
      openSession(fd.deps, { taskId: fd.taskId, windowId: secondaryId })
    ).resolves.toEqual(expect.any(String))
    expect(task.sessions().some((s) => s.windowId === secondaryId)).toBe(true)
  })

  it("refuses opening a session for task B in a window that belongs to task A's view", async () => {
    const fd = await seedReadyTask() // task-1 ("T")
    await createTask(fd.deps, taskInput('Other'))
    const otherTaskId = asTaskId('task-2')

    const viewResult = createView(fd.deps, { taskId: fd.taskId })
    const viewId = viewResult.ok ? viewResult.windowId! : (undefined as never)

    await expect(openSession(fd.deps, { taskId: otherTaskId, windowId: viewId })).rejects.toThrow(
      InvariantViolationError
    )
    await expect(openSession(fd.deps, { taskId: otherTaskId, windowId: viewId })).rejects.toThrow(
      /belongs to another task's view/
    )
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

describe('openSession background / launchCommand (octopus-cli control socket)', () => {
  it('returns the new session id', async () => {
    const fd = await seedReadyTask()
    const id = await openSession(fd.deps, { taskId: fd.taskId })
    expect(id).toBe(fd.workspace.task(fd.taskId)!.sessions()[0].id)
  })

  it('writes launchCommand once on the fresh spawn and never persists it', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, {
      taskId: fd.taskId,
      launchCommand: 'claude -- "p"',
      background: true
    })
    expect(fd.sessions.last()!.writes).toEqual(['claude -- "p"\n'])
    expect(JSON.stringify(fd.persistence.upsertedSessions)).not.toContain('claude')
    const cfg = fd.workspace.task(fd.taskId)!.sessions()[0].config
    expect(JSON.stringify(cfg)).not.toContain('claude')
  })

  it('flags sessionCreated as background only when requested', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId, background: true })
    await openSession(fd.deps, { taskId: fd.taskId })
    expect(fd.bus.ofType('sessionCreated').map((e) => e.background)).toEqual([true, undefined])
  })

  it('background with no windowId lands in main when the task has no view', async () => {
    const fd = await seedReadyTask()
    await openSession(fd.deps, { taskId: fd.taskId, background: true })
    expect(fd.workspace.task(fd.taskId)!.sessions()[0].windowId).toBe(MAIN_WINDOW_ID)
  })

  it("background with no windowId lands in the task's view window when one exists", async () => {
    const fd = await seedReadyTask()
    const v = createView(fd.deps, { taskId: fd.taskId })
    const viewId = v.ok ? v.windowId! : (undefined as never)

    await openSession(fd.deps, { taskId: fd.taskId, background: true })

    expect(fd.workspace.task(fd.taskId)!.sessions()[0].windowId).toBe(viewId)
  })

  it('a non-background open without windowId still targets main (and is refused when a view exists)', async () => {
    const fd = await seedReadyTask()
    createView(fd.deps, { taskId: fd.taskId })
    await expect(openSession(fd.deps, { taskId: fd.taskId })).rejects.toThrow(
      /dedicated view window/
    )
  })
})
