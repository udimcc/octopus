import { describe, it, expect, beforeEach } from 'vitest'
import {
  reduceEvent,
  initialData,
  useStore,
  sessionIdsInWindow,
  activeSessionInWindow,
  groupOfSession,
  isSessionFocused,
  sessionDisplayState,
  taskDisplayState,
  issueForTask,
  isIssueBoundElsewhere,
  type StoreData
} from './store'
import type {
  TaskDTO,
  SessionDTO,
  WindowedWorkspaceStateDTO,
  SplitNode,
  GroupDTO,
  IssueDTO
} from '../../../shared/dto'

function session(id: string, taskId: string, over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id,
    taskId,
    typeId: 'terminal',
    title: id,
    config: { kind: 'terminal' },
    lifecycle: 'running',
    state: 'unknown',
    order: 0,
    createdAt: 1000,
    windowId: 'main',
    ...over
  }
}

function task(id: string, over: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id,
    name: id,
    lifecycle: 'ready',
    state: 'unknown',
    sessions: [],
    position: 0,
    createdAt: 1000,
    groups: [],
    ...over
  }
}

function issue(id: string, over: Partial<IssueDTO> = {}): IssueDTO {
  return {
    id,
    name: id,
    description: '',
    status: 'todo',
    createdAt: 1000,
    updatedAt: 1000,
    ...over
  }
}

/** A leaf node naming `sessionId` — `split-layout.ts` only reads trees, it doesn't build them. */
function leaf(sessionId: string): SplitNode {
  return { kind: 'leaf', sessionId }
}

/** A backend-owned group (DESIGN §5.7) wrapping `layout`, as carried in `TaskDTO.groups`/`groupsByTask`. */
function group(id: string, layout: SplitNode, colorIndex = 0): GroupDTO {
  return { id, layout, colorIndex }
}

describe('reduceEvent (§5.2)', () => {
  it('ignores ptyData entirely — it never enters the store', () => {
    const d = initialData()
    const next = reduceEvent(d, { type: 'ptyData', sessionId: 's1', data: 'x'.repeat(1000) })
    expect(next).toBe(d) // same reference: no state churn
  })

  it('taskCreated inserts a new task and appends it to the order', () => {
    const d = initialData()
    const next = reduceEvent(d, { type: 'taskCreated', task: task('t1', { name: 'Alpha' }) })
    expect(next.taskOrder).toEqual(['t1'])
    expect(next.tasks.t1.name).toBe('Alpha')
  })

  it('taskCreated is an upsert — the second (Ready) emit does not duplicate the order', () => {
    let d = reduceEvent(initialData(), {
      type: 'taskCreated',
      task: task('t1', { lifecycle: 'provisioning' })
    })
    d = reduceEvent(d, { type: 'taskCreated', task: task('t1', { lifecycle: 'ready' }) })
    expect(d.taskOrder).toEqual(['t1'])
    expect(d.tasks.t1.lifecycle).toBe('ready')
  })

  it('taskCreated normalizes nested sessions into the flat map + ordered ids', () => {
    const t = task('t1', {
      sessions: [session('s2', 't1', { order: 1 }), session('s1', 't1', { order: 0 })],
      activeSessionId: 's1'
    })
    const d = reduceEvent(initialData(), { type: 'taskCreated', task: t })
    expect(d.tasks.t1.sessionIds).toEqual(['s1', 's2']) // sorted by order
    expect(Object.keys(d.sessions).sort()).toEqual(['s1', 's2'])
    expect(d.activeSessionByTask.t1).toBe('s1')
  })

  it('sessionCreated appends the session and makes it the active tab', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    expect(d.tasks.t1.sessionIds).toEqual(['s1'])
    expect(d.sessions.s1).toBeDefined()
    expect(d.activeSessionByTask.t1).toBe('s1')
  })

  it('sessionExited marks the session exited but keeps it as a tab', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionExited', taskId: 't1', sessionId: 's1', exitCode: 3 })
    expect(d.tasks.t1.sessionIds).toEqual(['s1']) // still present
    expect(d.sessions.s1.lifecycle).toBe('exited')
  })

  it('sessionExited with a non-zero code enqueues an error toast (§5.4)', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, {
      type: 'sessionCreated',
      taskId: 't1',
      session: session('s1', 't1', { title: 'build' })
    })
    d = reduceEvent(d, { type: 'sessionExited', taskId: 't1', sessionId: 's1', exitCode: 137 })
    expect(d.toasts).toHaveLength(1)
    expect(d.toasts[0]).toMatchObject({ kind: 'error' })
    expect(d.toasts[0].message).toContain('build')
    expect(d.toasts[0].message).toContain('137')
  })

  it('sessionExited with a missing code toasts an "unexpectedly" error', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionExited', taskId: 't1', sessionId: 's1' })
    expect(d.toasts).toHaveLength(1)
    expect(d.toasts[0].message).toContain('unexpectedly')
  })

  it('sessionExited with a clean exit code (0) is silent — no toast', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionExited', taskId: 't1', sessionId: 's1', exitCode: 0 })
    expect(d.toasts).toEqual([])
    expect(d.sessions.s1.lifecycle).toBe('exited')
  })

  it('sessionClosed removes the session and re-points the active tab to the survivor', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    // s2 is active (most recently created); close it → active falls back to s1.
    expect(d.activeSessionByTask.t1).toBe('s2')
    d = reduceEvent(d, { type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
    expect(d.tasks.t1.sessionIds).toEqual(['s1'])
    expect(d.sessions.s2).toBeUndefined()
    expect(d.activeSessionByTask.t1).toBe('s1')
  })

  /** The user's layout: window `main` hosts s1, s2; window `win-2` hosts s3, s4 (task t1). */
  function twoWindows(thisWindowId: string): StoreData {
    let d: StoreData = { ...initialData(), windowId: thisWindowId }
    d = reduceEvent(d, { type: 'taskCreated', task: task('t1') })
    for (const [id, windowId] of [
      ['s1', 'main'],
      ['s2', 'main'],
      ['s3', 'win-2'],
      ['s4', 'win-2']
    ]) {
      d = reduceEvent(d, {
        type: 'sessionCreated',
        taskId: 't1',
        session: session(id, 't1', { windowId })
      })
    }
    return d
  }

  it('each window marks its own session; a new session is marked only by its host (§3.7)', () => {
    // Every window learns of every session, but marks only the ones it hosts: main's
    // last-created hosted tab is s2, win-2's is s4.
    const main = twoWindows('main')
    expect(main.tasks.t1.sessionIds).toEqual(['s1', 's2', 's3', 's4'])
    expect(main.activeSessionByTask.t1).toBe('s2')
    expect(twoWindows('win-2').activeSessionByTask.t1).toBe('s4')
  })

  it('activeSessionChanged moves ONLY the host window mark; the window left keeps its own (§3.7)', () => {
    // The reported bug: from s2 (main), switching to s3 (win-2) left main showing s1 with
    // no tab marked, because the shared pointer pointed into win-2.
    const event = {
      type: 'activeSessionChanged',
      taskId: 't1',
      sessionId: 's3',
      windowId: 'win-2'
    } as const
    const main = reduceEvent({ ...twoWindows('main'), activeTaskId: undefined }, event)
    expect(main.activeSessionByTask.t1).toBe('s2')
    expect(activeSessionInWindow(main, 't1', 'main')).toBe('s2')
    expect(main.activeTaskId).toBeUndefined() // non-host: the active TASK doesn't move either

    // Host window: moves its mark and makes the task active so its view is on screen
    // when the OS raises it.
    const host = reduceEvent({ ...twoWindows('win-2'), activeTaskId: undefined }, event)
    expect(host.activeSessionByTask.t1).toBe('s3')
    expect(host.activeTaskId).toBe('t1')
  })

  it('activeSessionChanged flashes the host only when it lands while the host is unfocused (§5.4)', () => {
    const event = {
      type: 'activeSessionChanged',
      taskId: 't1',
      sessionId: 's3',
      windowId: 'win-2'
    } as const
    // Cross-window: the host is still blurred (the raise is in flight) → flash now.
    const blurredHost = reduceEvent({ ...twoWindows('win-2'), windowFocused: false }, event)
    expect(blurredHost.focusFlashOn).toBe(true)
    expect(blurredHost.focusFlashSeq).toBe(1)
    // Same-window switch: the host already has focus → no flash.
    expect(reduceEvent(twoWindows('win-2'), event).focusFlashOn).toBe(false)
    // Non-host never flashes.
    expect(reduceEvent({ ...twoWindows('main'), windowFocused: false }, event).focusFlashOn).toBe(
      false
    )
  })

  it('activeSessionChanged clears the ready-for-review flag in EVERY window (§9.5)', () => {
    // The clear is global: switching to a session focuses+raises its host window, so
    // the user HAS looked at it. Every window's store must drop the flag, because the
    // task rollup (`taskDisplayState`) is shown only in the main window yet folds over
    // sessions hosted in ANY window — a host-only clear left the main window's task dot
    // lit after focusing a session that lives elsewhere.
    let d: StoreData = { ...initialData(), windowId: 'main' }
    d = reduceEvent(d, { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    // A second session becomes the active tab, so s1 is now UNFOCUSED — required for
    // its working → waiting transition to raise the ready-for-review flag (§9.5).
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'working' })
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'waiting' })
    expect(d.hasUnseenFinishedTurn.s1).toBe(true)

    // Switching to it while its host is a DIFFERENT window still clears here: this
    // (main) window renders the task rollup, and the session is now focused elsewhere.
    const elsewhere = reduceEvent(d, {
      type: 'activeSessionChanged',
      taskId: 't1',
      sessionId: 's1',
      windowId: 'win-9'
    })
    expect(elsewhere.hasUnseenFinishedTurn.s1).toBeUndefined()
    // s1 is `waiting` with the flag cleared → rollup falls back to plain idle, not review.
    expect(taskDisplayState(elsewhere, 't1')).toBe('idle')

    // Switching to it in the host window ('main') clears it too.
    const here = reduceEvent(d, {
      type: 'activeSessionChanged',
      taskId: 't1',
      sessionId: 's1',
      windowId: 'main'
    })
    expect(here.hasUnseenFinishedTurn.s1).toBeUndefined()
  })

  it('sessionClosed recomputes the task worst-wins state, dropping the closed rank (§3.4)', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, {
      type: 'sessionCreated',
      taskId: 't1',
      session: session('s1', 't1', { state: 'waiting' })
    })
    d = reduceEvent(d, {
      type: 'sessionCreated',
      taskId: 't1',
      session: session('s2', 't1', { state: 'working' })
    })
    // Task rolls up to 'working' (worst of waiting + working).
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's2', state: 'working' })
    expect(d.tasks.t1.state).toBe('working')
    // Closing the working session drops the task back to its survivor's 'waiting'.
    d = reduceEvent(d, { type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
    expect(d.tasks.t1.state).toBe('waiting')
  })

  it('sessionClosed on the last non-idle session returns the task to unknown', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, {
      type: 'sessionCreated',
      taskId: 't1',
      session: session('s1', 't1', { state: 'working' })
    })
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'working' })
    expect(d.tasks.t1.state).toBe('working')
    d = reduceEvent(d, { type: 'sessionClosed', taskId: 't1', sessionId: 's1' })
    expect(d.tasks.t1.state).toBe('unknown')
  })

  it('sessionExited raises the task worst-wins state to blocked (exited aggregates as NeedsInput)', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, {
      type: 'sessionCreated',
      taskId: 't1',
      session: session('s1', 't1', { state: 'waiting' })
    })
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'waiting' })
    expect(d.tasks.t1.state).toBe('waiting')
    d = reduceEvent(d, { type: 'sessionExited', taskId: 't1', sessionId: 's1', exitCode: 0 })
    expect(d.tasks.t1.state).toBe('blocked')
  })

  it('sessionClosed on the last session drops the active-tab entry', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionClosed', taskId: 't1', sessionId: 's1' })
    expect(d.tasks.t1.sessionIds).toEqual([])
    expect(d.activeSessionByTask.t1).toBeUndefined()
  })

  it('taskDeleted removes the task, its sessions, order, and active pointer', () => {
    let d = reduceEvent(initialData(), {
      type: 'taskCreated',
      task: task('t1', { sessions: [session('s1', 't1')] })
    })
    d = reduceEvent(d, { type: 'activeTaskChanged', taskId: 't1' })
    d = reduceEvent(d, { type: 'taskDeleted', taskId: 't1' })
    expect(d.tasks.t1).toBeUndefined()
    expect(d.sessions.s1).toBeUndefined()
    expect(d.taskOrder).toEqual([])
    expect(d.activeTaskId).toBeUndefined()
  })

  it('taskRenamed / taskStale patch the task in place', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1', { name: 'Old' }) })
    d = reduceEvent(d, { type: 'taskRenamed', taskId: 't1', name: 'New' })
    expect(d.tasks.t1.name).toBe('New')
    d = reduceEvent(d, { type: 'taskStale', taskId: 't1' })
    expect(d.tasks.t1.lifecycle).toBe('stale')
  })

  it('activeTaskChanged updates (and clears) the active task', () => {
    let d = reduceEvent(initialData(), { type: 'activeTaskChanged', taskId: 't1' })
    expect(d.activeTaskId).toBe('t1')
    d = reduceEvent(d, { type: 'activeTaskChanged', taskId: undefined })
    expect(d.activeTaskId).toBeUndefined()
  })

  it('taskReordered keeps only known task ids, in the given order', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'taskCreated', task: task('t2') })
    d = reduceEvent(d, { type: 'taskReordered', orderedTaskIds: ['t2', 't1', 'ghost'] })
    expect(d.taskOrder).toEqual(['t2', 't1'])
  })

  it('sessionReordered reorders a task’s session ids (known only)', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    d = reduceEvent(d, {
      type: 'sessionReordered',
      taskId: 't1',
      orderedSessionIds: ['s2', 's1', 'ghost']
    })
    expect(d.tasks.t1.sessionIds).toEqual(['s2', 's1'])
  })

  it('sessionRenamed updates the session title', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionRenamed', taskId: 't1', sessionId: 's1', title: 'build' })
    expect(d.sessions.s1.title).toBe('build')
  })

  it('scriptError and error events enqueue a toast', () => {
    let d: StoreData = initialData()
    d = reduceEvent(d, {
      type: 'scriptError',
      taskId: 't1',
      script: '/c',
      exitCode: 1,
      stderr: '  boom  '
    })
    expect(d.toasts).toHaveLength(1)
    expect(d.toasts[0]).toMatchObject({ kind: 'error', message: 'boom' })
    d = reduceEvent(d, { type: 'error', message: 'bad' })
    expect(d.toasts.map((t) => t.message)).toEqual(['boom', 'bad'])
    expect(new Set(d.toasts.map((t) => t.id)).size).toBe(2) // unique ids
  })

  it('scriptProgress does not touch the global store', () => {
    const d = initialData()
    expect(reduceEvent(d, { type: 'scriptProgress', taskId: 't1', line: 'x' })).toBe(d)
  })

  it('dormant state events patch state fields but are emitted by nobody in V1 (§10)', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'taskStateChanged', taskId: 't1', state: 'working' })
    expect(d.tasks.t1.state).toBe('working')
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'blocked' })
    expect(d.sessions.s1.state).toBe('blocked')
  })

  it('sessionStateChanged rolls the worst session state up into the task (§3.4, bug 2.1)', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    // s1 goes idle, s2 needs input → the task must reflect the WORST (needs input),
    // not the last-delivered session state, and without a separate taskStateChanged.
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'waiting' })
    expect(d.tasks.t1.state).toBe('waiting')
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's2', state: 'blocked' })
    expect(d.tasks.t1.state).toBe('blocked')
    // s2 answered → both idle → task falls back to idle.
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's2', state: 'waiting' })
    expect(d.tasks.t1.state).toBe('waiting')
  })

  it('sessionMovedToWindow patches only the session windowId (taskId untouched, I18)', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    expect(d.sessions.s1.windowId).toBe('main')
    d = reduceEvent(d, {
      type: 'sessionMovedToWindow',
      sessionId: 's1',
      taskId: 't1',
      fromWindowId: 'main',
      toWindowId: 'win-2'
    })
    expect(d.sessions.s1.windowId).toBe('win-2')
    expect(d.sessions.s1.taskId).toBe('t1') // never changes
    // The session stays in the task's tab list — a move is not a close.
    expect(d.tasks.t1.sessionIds).toEqual(['s1'])
  })

  it('sessionMovedToWindow for an unknown session is a no-op (same reference)', () => {
    const d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    const next = reduceEvent(d, {
      type: 'sessionMovedToWindow',
      sessionId: 'ghost',
      taskId: 't1',
      fromWindowId: 'main',
      toWindowId: 'win-2'
    })
    expect(next).toBe(d)
  })

  it('windowCreated appends a window; a duplicate id is idempotent', () => {
    const bounds = { x: 0, y: 0, width: 900, height: 640 }
    let d = reduceEvent(initialData(), {
      type: 'windowCreated',
      windowId: 'win-2',
      role: 'secondary',
      bounds
    })
    expect(d.windows.map((w) => w.id)).toEqual(['win-2'])
    expect(d.windows[0]).toMatchObject({ id: 'win-2', role: 'secondary', bounds })
    // Re-emit the same id → no duplicate.
    d = reduceEvent(d, { type: 'windowCreated', windowId: 'win-2', role: 'secondary', bounds })
    expect(d.windows.map((w) => w.id)).toEqual(['win-2'])
  })

  it('windowClosed removes the window from the list', () => {
    const bounds = { x: 0, y: 0, width: 900, height: 640 }
    let d = reduceEvent(initialData(), {
      type: 'windowCreated',
      windowId: 'win-2',
      role: 'secondary',
      bounds
    })
    d = reduceEvent(d, { type: 'windowClosed', windowId: 'win-2' })
    expect(d.windows).toEqual([])
  })
})

describe('sessionIdsInWindow / activeSessionInWindow (§5.6 per-window projection)', () => {
  it('filters a task’s sessions to those hosted by the given window, in tab order', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    // Move s2 out to a secondary window.
    d = reduceEvent(d, {
      type: 'sessionMovedToWindow',
      sessionId: 's2',
      taskId: 't1',
      fromWindowId: 'main',
      toWindowId: 'win-2'
    })
    expect(sessionIdsInWindow(d, 't1', 'main')).toEqual(['s1'])
    expect(sessionIdsInWindow(d, 't1', 'win-2')).toEqual(['s2'])
    expect(sessionIdsInWindow(d, 'ghost', 'main')).toEqual([])
  })

  it('activeSessionInWindow prefers the window-scoped active tab, else the first windowed session', () => {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    // Global active tab is s2 (most recently created), but it lives in win-2.
    d = reduceEvent(d, {
      type: 'sessionMovedToWindow',
      sessionId: 's2',
      taskId: 't1',
      fromWindowId: 'main',
      toWindowId: 'win-2'
    })
    // In the main window the global active (s2) is not present → falls back to s1.
    expect(activeSessionInWindow(d, 't1', 'main')).toBe('s1')
    // In win-2 the global active tab still resolves (it lives there).
    expect(activeSessionInWindow(d, 't1', 'win-2')).toBe('s2')
    // A window hosting none of the task's sessions → undefined.
    expect(activeSessionInWindow(d, 't1', 'win-9')).toBeUndefined()
  })
})

describe('useStore hydrate + actions', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  const state: WindowedWorkspaceStateDTO = {
    tasks: [
      task('t2', { position: 1 }),
      task('t1', {
        position: 0,
        sessions: [session('s1', 't1')],
        activeSessionId: 's1'
      })
    ],
    activeTaskId: 't1',
    sessionTypes: [
      {
        typeId: 'terminal',
        displayName: 'Terminal',
        icon: '',
        availableFromVersion: 1,
        configSchema: {}
      }
    ],
    issues: [],
    settings: {
      worktree: { location: '/home/u/octopus_repos' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true
    },
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: []
  }

  it('hydrate projects the snapshot in position order and derives active tabs', () => {
    useStore.getState().hydrate(state)
    const s = useStore.getState()
    expect(s.taskOrder).toEqual(['t1', 't2']) // sorted by position
    expect(s.activeTaskId).toBe('t1')
    expect(s.activeSessionByTask.t1).toBe('s1')
    expect(s.sessionTypes.map((t) => t.typeId)).toEqual(['terminal'])
  })

  it('applyEvent runs the reducer against live state', () => {
    useStore.getState().hydrate(state)
    useStore.getState().applyEvent({ type: 'taskRenamed', taskId: 't1', name: 'Renamed' })
    expect(useStore.getState().tasks.t1.name).toBe('Renamed')
  })

  it('setActiveTask / setActiveSession update pointers', () => {
    useStore.getState().hydrate(state)
    useStore.getState().setActiveTask('t2')
    expect(useStore.getState().activeTaskId).toBe('t2')
    useStore.getState().setActiveSession('t1', 's1')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
  })

  it('pushToast / dismissToast manage the toast queue', () => {
    useStore.getState().pushToast('info', 'hi')
    const id = useStore.getState().toasts[0].id
    useStore.getState().dismissToast(id)
    expect(useStore.getState().toasts).toEqual([])
  })
})

/**
 * Issues store logic ("Issues"): the `issues` projection, the drawer's renderer-local
 * view-state (never persisted), and the two reverse-lookup selectors.
 */
describe('Issues store (drawer view-state + issues projection)', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  const issuesState: WindowedWorkspaceStateDTO = {
    tasks: [],
    activeTaskId: undefined,
    sessionTypes: [],
    issues: [issue('i1'), issue('i2', { status: 'in_review' })],
    settings: initialData().settings,
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: []
  }

  describe('hydrate', () => {
    it('projects WindowedWorkspaceStateDTO.issues into a keyed record', () => {
      useStore.getState().hydrate(issuesState)
      const s = useStore.getState()
      expect(Object.keys(s.issues).sort()).toEqual(['i1', 'i2'])
      expect(s.issues.i2.status).toBe('in_review')
    })

    it('keeps a still-valid selection and other drawer view-state across re-hydration', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().openIssuesDrawer('i1')
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().hydrate(issuesState)
      const s = useStore.getState()
      expect(s.issuesDrawerOpen).toBe(true)
      expect(s.selectedIssueId).toBe('i1')
      expect(s.issueEditSession).toBe(sessionBefore)
    })

    it('also preserves issueEditDirty and a pending discardPrompt across re-hydration when the selection stays valid', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().openIssuesDrawer('i1')
      useStore.getState().setIssueEditDirty(true)
      useStore.getState().selectIssue('i2') // dirty -> raises discardPrompt {kind:'select', issueId:'i2'}
      expect(useStore.getState().discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })

      useStore.getState().hydrate(issuesState) // same issues: selection (i1) is still valid
      const s = useStore.getState()
      expect(s.selectedIssueId).toBe('i1')
      expect(s.issueEditDirty).toBe(true)
      expect(s.discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })
    })

    it('preserves an in-progress issueDraft across re-hydration', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().startNewIssue()
      useStore.getState().setIssueEditDirty(true)
      useStore.getState().hydrate(issuesState)
      const s = useStore.getState()
      expect(s.issueDraft).toBe(true)
      expect(s.issueEditDirty).toBe(true)
    })

    it('drops a selection whose issue no longer exists in the hydrated snapshot, bumping the session', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().openIssuesDrawer('i1')
      const sessionBefore = useStore.getState().issueEditSession
      const withoutI1: WindowedWorkspaceStateDTO = { ...issuesState, issues: [issue('i2')] }
      useStore.getState().hydrate(withoutI1)
      const s = useStore.getState()
      expect(s.selectedIssueId).toBeUndefined()
      expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
      // The dropped selection also discards any dirty edit tied to it.
      expect(s.issueEditDirty).toBe(false)
    })

    it('clears a pending select-discardPrompt whose target issue is dropped by the hydration', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().openIssuesDrawer('i1')
      useStore.getState().setIssueEditDirty(true)
      useStore.getState().selectIssue('i2') // dirty → raises discardPrompt {kind:'select', issueId:'i2'}
      expect(useStore.getState().discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })
      const withoutI2: WindowedWorkspaceStateDTO = { ...issuesState, issues: [issue('i1')] }
      useStore.getState().hydrate(withoutI2)
      expect(useStore.getState().discardPrompt).toBeNull()
    })
  })

  describe('reduceEvent: issueUpserted / issueDeleted / issuesDrawerToggle', () => {
    it('issueUpserted adds a new issue', () => {
      const next = reduceEvent(initialData(), { type: 'issueUpserted', issue: issue('i1') })
      expect(next.issues.i1).toEqual(issue('i1'))
    })

    it('issueUpserted overwrites an existing issue by id', () => {
      const seeded = { ...initialData(), issues: { i1: issue('i1') } }
      const next = reduceEvent(seeded, {
        type: 'issueUpserted',
        issue: issue('i1', { name: 'Renamed', status: 'done' })
      })
      expect(next.issues.i1.name).toBe('Renamed')
      expect(next.issues.i1.status).toBe('done')
      expect(Object.keys(next.issues)).toEqual(['i1'])
    })

    it('issueDeleted removes the issue and leaves an unrelated selection untouched', () => {
      const seeded = {
        ...initialData(),
        issues: { i1: issue('i1'), i2: issue('i2') },
        selectedIssueId: 'i2'
      }
      const next = reduceEvent(seeded, { type: 'issueDeleted', issueId: 'i1' })
      expect(next.issues.i1).toBeUndefined()
      expect(next.issues.i2).toBeDefined()
      expect(next.selectedIssueId).toBe('i2')
      expect(next.issueEditSession).toBe(seeded.issueEditSession)
    })

    it('issueDeleted clears the selection, draft, dirty flag and discardPrompt when the SELECTED issue is deleted, and bumps the session', () => {
      const seeded = {
        ...initialData(),
        issues: { i1: issue('i1') },
        selectedIssueId: 'i1',
        issueDraft: false,
        issueEditDirty: true,
        discardPrompt: { kind: 'close' as const }
      }
      const next = reduceEvent(seeded, { type: 'issueDeleted', issueId: 'i1' })
      expect(next.selectedIssueId).toBeUndefined()
      expect(next.issueDraft).toBe(false)
      expect(next.issueEditDirty).toBe(false)
      expect(next.discardPrompt).toBeNull()
      expect(next.issueEditSession).toBeGreaterThan(seeded.issueEditSession)
    })

    it('issueDeleted clears a pending select-discardPrompt that targets the deleted issue, even when it is not the current selection', () => {
      const seeded = {
        ...initialData(),
        issues: { i1: issue('i1'), i2: issue('i2') },
        selectedIssueId: 'i2',
        discardPrompt: { kind: 'select' as const, issueId: 'i1' }
      }
      const next = reduceEvent(seeded, { type: 'issueDeleted', issueId: 'i1' })
      expect(next.discardPrompt).toBeNull()
      // Not the selected issue, so the selection itself is untouched.
      expect(next.selectedIssueId).toBe('i2')
    })

    it('issuesDrawerToggle opens a closed drawer', () => {
      const next = reduceEvent(initialData(), { type: 'issuesDrawerToggle' })
      expect(next.issuesDrawerOpen).toBe(true)
    })

    it('issuesDrawerToggle closes an open, clean drawer and clears any draft', () => {
      const seeded = { ...initialData(), issuesDrawerOpen: true, issueDraft: true }
      const next = reduceEvent(seeded, { type: 'issuesDrawerToggle' })
      expect(next.issuesDrawerOpen).toBe(false)
      expect(next.issueDraft).toBe(false)
    })

    it('issuesDrawerToggle on a dirty open drawer raises discardPrompt instead of closing — same as the toggleIssuesDrawer action', () => {
      const seeded = { ...initialData(), issuesDrawerOpen: true, issueEditDirty: true }
      const viaEvent = reduceEvent(seeded, { type: 'issuesDrawerToggle' })
      expect(viaEvent.issuesDrawerOpen).toBe(true)
      expect(viaEvent.discardPrompt).toEqual({ kind: 'close' })

      useStore.setState(seeded)
      useStore.getState().toggleIssuesDrawer()
      const viaAction = useStore.getState()
      expect(viaAction.issuesDrawerOpen).toBe(true)
      expect(viaAction.discardPrompt).toEqual({ kind: 'close' })
    })
  })

  describe('toggleIssuesDrawer action', () => {
    it('opens a closed drawer', () => {
      useStore.getState().toggleIssuesDrawer()
      expect(useStore.getState().issuesDrawerOpen).toBe(true)
    })

    it('closes an open, clean drawer and clears a draft', () => {
      useStore.setState({ issuesDrawerOpen: true, issueDraft: true })
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().toggleIssuesDrawer()
      const s = useStore.getState()
      expect(s.issuesDrawerOpen).toBe(false)
      expect(s.issueDraft).toBe(false)
      expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
    })

    it('raises discardPrompt {kind:"close"} instead of closing while dirty', () => {
      useStore.setState({ issuesDrawerOpen: true, issueEditDirty: true })
      useStore.getState().toggleIssuesDrawer()
      const s = useStore.getState()
      expect(s.issuesDrawerOpen).toBe(true)
      expect(s.discardPrompt).toEqual({ kind: 'close' })
    })
  })

  describe('openIssuesDrawer', () => {
    it('opens a closed drawer with no id, keeping the previous selection', () => {
      useStore.setState({ selectedIssueId: 'i9' })
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().openIssuesDrawer()
      const s = useStore.getState()
      expect(s.issuesDrawerOpen).toBe(true)
      expect(s.selectedIssueId).toBe('i9')
      expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
    })

    it('opens a closed drawer directly onto the given issue', () => {
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().openIssuesDrawer('i1')
      const s = useStore.getState()
      expect(s.issuesDrawerOpen).toBe(true)
      expect(s.selectedIssueId).toBe('i1')
      expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
    })

    it('reselecting the already-shown clean issue on an open drawer is a no-op (no session bump)', () => {
      useStore.setState({ issuesDrawerOpen: true, selectedIssueId: 'i1', issueDraft: false })
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().openIssuesDrawer('i1')
      const s = useStore.getState()
      expect(s.selectedIssueId).toBe('i1')
      expect(s.issueEditSession).toBe(sessionBefore)
    })

    it('selecting a different issue on an open, dirty drawer raises discardPrompt', () => {
      useStore.setState({ issuesDrawerOpen: true, selectedIssueId: 'i1', issueEditDirty: true })
      useStore.getState().openIssuesDrawer('i2')
      const s = useStore.getState()
      expect(s.selectedIssueId).toBe('i1')
      expect(s.discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })
    })

    it('selecting a different issue on an open, clean drawer switches directly and bumps the session', () => {
      useStore.setState({ issuesDrawerOpen: true, selectedIssueId: 'i1', issueDraft: false })
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().openIssuesDrawer('i2')
      const s = useStore.getState()
      expect(s.selectedIssueId).toBe('i2')
      expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
    })
  })

  describe('selectIssue', () => {
    it('dirty-guards: raises discardPrompt instead of switching', () => {
      useStore.setState({ issuesDrawerOpen: true, selectedIssueId: 'i1', issueEditDirty: true })
      useStore.getState().selectIssue('i2')
      const s = useStore.getState()
      expect(s.selectedIssueId).toBe('i1')
      expect(s.discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })
    })

    it('clean select switches and clears draft/dirty', () => {
      useStore.setState({
        issuesDrawerOpen: true,
        selectedIssueId: 'i1',
        issueDraft: true,
        issueEditDirty: false
      })
      useStore.getState().selectIssue('i2')
      const s = useStore.getState()
      expect(s.selectedIssueId).toBe('i2')
      expect(s.issueDraft).toBe(false)
      expect(s.issueEditDirty).toBe(false)
    })
  })

  describe('issuesDrawerTab (Board tab, renderer-local view state)', () => {
    it('defaults to "list"', () => {
      expect(useStore.getState().issuesDrawerTab).toBe('list')
    })

    it('setIssuesDrawerTab survives a close/reopen of the drawer', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().setIssuesDrawerTab('board')
      useStore.getState().toggleIssuesDrawer() // open
      useStore.getState().toggleIssuesDrawer() // close
      expect(useStore.getState().issuesDrawerTab).toBe('board')
      useStore.getState().toggleIssuesDrawer() // reopen
      expect(useStore.getState().issuesDrawerTab).toBe('board')
    })

    it('survives openIssuesDrawer(id)', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().setIssuesDrawerTab('board')
      useStore.getState().openIssuesDrawer('i1')
      expect(useStore.getState().issuesDrawerTab).toBe('board')
    })

    it('survives hydrate (never carried on the wire)', () => {
      useStore.getState().hydrate(issuesState)
      useStore.getState().setIssuesDrawerTab('board')
      useStore.getState().hydrate(issuesState)
      expect(useStore.getState().issuesDrawerTab).toBe('board')
    })

    it('setting the same tab is a no-op (no state replacement)', () => {
      expect(useStore.getState().issuesDrawerTab).toBe('list')
      const before = useStore.getState()
      useStore.getState().setIssuesDrawerTab('list')
      expect(useStore.getState()).toBe(before)
    })
  })

  describe('startNewIssue', () => {
    it('dirty-guards: raises discardPrompt {kind:"new"}', () => {
      useStore.setState({ issuesDrawerOpen: true, selectedIssueId: 'i1', issueEditDirty: true })
      useStore.getState().startNewIssue()
      const s = useStore.getState()
      expect(s.issueDraft).toBe(false)
      expect(s.discardPrompt).toEqual({ kind: 'new' })
    })

    it('clean call starts a draft: clears the selection and the dirty flag, and bumps the session', () => {
      useStore.setState({ issuesDrawerOpen: true, selectedIssueId: 'i1', issueEditDirty: false })
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().startNewIssue()
      const s = useStore.getState()
      expect(s.issueDraft).toBe(true)
      expect(s.selectedIssueId).toBeUndefined()
      expect(s.issueEditDirty).toBe(false)
      expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
    })
  })

  it('setIssueEditDirty round-trips the flag', () => {
    useStore.getState().setIssueEditDirty(true)
    expect(useStore.getState().issueEditDirty).toBe(true)
    useStore.getState().setIssueEditDirty(false)
    expect(useStore.getState().issueEditDirty).toBe(false)
  })

  describe('confirmDiscard', () => {
    it('performs a pending close: closes the drawer and clears the dirty/draft/prompt state', () => {
      useStore.setState({
        issuesDrawerOpen: true,
        issueEditDirty: true,
        discardPrompt: { kind: 'close' }
      })
      useStore.getState().confirmDiscard()
      const s = useStore.getState()
      expect(s.issuesDrawerOpen).toBe(false)
      expect(s.issueEditDirty).toBe(false)
      expect(s.discardPrompt).toBeNull()
    })

    it('performs a pending select: switches to the target issue', () => {
      useStore.setState({
        issuesDrawerOpen: true,
        selectedIssueId: 'i1',
        issueEditDirty: true,
        discardPrompt: { kind: 'select', issueId: 'i2' }
      })
      useStore.getState().confirmDiscard()
      const s = useStore.getState()
      expect(s.selectedIssueId).toBe('i2')
      expect(s.issueEditDirty).toBe(false)
      expect(s.discardPrompt).toBeNull()
    })

    it('performs a pending new: starts a fresh draft', () => {
      useStore.setState({
        issuesDrawerOpen: true,
        selectedIssueId: 'i1',
        issueEditDirty: true,
        discardPrompt: { kind: 'new' }
      })
      useStore.getState().confirmDiscard()
      const s = useStore.getState()
      expect(s.issueDraft).toBe(true)
      expect(s.selectedIssueId).toBeUndefined()
      expect(s.discardPrompt).toBeNull()
    })

    it('is a no-op without a pending discardPrompt', () => {
      const before = useStore.getState()
      useStore.getState().confirmDiscard()
      expect(useStore.getState()).toBe(before)
    })

    it('bumps issueEditSession even when discarding a draft lands back on another fresh draft (kind:"new")', () => {
      useStore.setState({
        issuesDrawerOpen: true,
        issueDraft: true,
        issueEditDirty: true,
        discardPrompt: { kind: 'new' }
      })
      const sessionBefore = useStore.getState().issueEditSession
      useStore.getState().confirmDiscard()
      const s = useStore.getState()
      // The visible issueDraft/selectedIssueId pair is unchanged (draft → draft), but
      // the session must still bump so IssueDetail's reset effect clears stale text.
      expect(s.issueDraft).toBe(true)
      expect(s.selectedIssueId).toBeUndefined()
      expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
    })
  })

  it('cancelDiscard clears only the discardPrompt, leaving the dirty edit and selection untouched', () => {
    useStore.setState({
      issuesDrawerOpen: true,
      selectedIssueId: 'i1',
      issueEditDirty: true,
      discardPrompt: { kind: 'select', issueId: 'i2' }
    })
    useStore.getState().cancelDiscard()
    const s = useStore.getState()
    expect(s.discardPrompt).toBeNull()
    expect(s.selectedIssueId).toBe('i1')
    expect(s.issueEditDirty).toBe(true)
  })

  it('cancelNewIssue discards a draft directly, without touching issuesDrawerOpen/selectedIssueId or raising a discardPrompt', () => {
    useStore.setState({
      issuesDrawerOpen: true,
      selectedIssueId: 'i1',
      issueDraft: true,
      issueEditDirty: true
    })
    const sessionBefore = useStore.getState().issueEditSession
    useStore.getState().cancelNewIssue()
    const s = useStore.getState()
    expect(s.issueDraft).toBe(false)
    expect(s.issueEditDirty).toBe(false)
    expect(s.issuesDrawerOpen).toBe(true)
    expect(s.issueEditSession).toBeGreaterThan(sessionBefore)
    expect(s.selectedIssueId).toBe('i1')
    expect(s.discardPrompt).toBeNull()
  })

  describe('issueForTask / isIssueBoundElsewhere selectors', () => {
    it('issueForTask finds the issue bound to a task via the reverse lookup', () => {
      const data = { ...initialData(), issues: { i1: issue('i1', { taskId: 't1' }) } }
      expect(issueForTask(data, 't1')?.id).toBe('i1')
    })

    it('issueForTask returns undefined when no issue is bound to the task', () => {
      const data = { ...initialData(), issues: { i1: issue('i1') } }
      expect(issueForTask(data, 't1')).toBeUndefined()
    })

    it('isIssueBoundElsewhere is true only when bound to a DIFFERENT task', () => {
      expect(isIssueBoundElsewhere(issue('i1', { taskId: 't2' }), 't1')).toBe(true)
    })

    it('isIssueBoundElsewhere is false when unbound', () => {
      expect(isIssueBoundElsewhere(issue('i1'), 't1')).toBe(false)
    })

    it('isIssueBoundElsewhere is false when bound to the same task', () => {
      expect(isIssueBoundElsewhere(issue('i1', { taskId: 't1' }), 't1')).toBe(false)
    })
  })
})

/**
 * Per-window marks (§3.7): each window keeps its OWN marked tab per task — a session it
 * hosts, or none. The window left by a cross-window switch keeps showing what it had.
 */
describe('per-window marks (§3.7)', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  /** Snapshot: t1 has s1, s2 in `main` and s3, s4 in `win-2`; persisted pointer `active`. */
  function snapshot(thisWindowId: string, active?: string): WindowedWorkspaceStateDTO {
    return {
      tasks: [
        task('t1', {
          sessions: [
            session('s1', 't1', { order: 0 }),
            session('s2', 't1', { order: 1 }),
            session('s3', 't1', { order: 2, windowId: 'win-2' }),
            session('s4', 't1', { order: 3, windowId: 'win-2' })
          ],
          activeSessionId: active
        })
      ],
      activeTaskId: 't1',
      sessionTypes: [],
      issues: [],
      settings: initialData().settings,
      version: 1,
      thisWindowId,
      thisWindowRole: thisWindowId === 'main' ? 'main' : 'secondary',
      windows: []
    }
  }

  it('hydrate marks the persisted pointer where it is hosted, else the first hosted tab', () => {
    useStore.getState().hydrate(snapshot('win-2', 's4'))
    expect(useStore.getState().activeSessionByTask.t1).toBe('s4')
    useStore.setState(initialData())
    useStore.getState().hydrate(snapshot('main', 's4'))
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
  })

  it('hydrate leaves no mark in a window hosting none of the task’s sessions', () => {
    useStore.getState().hydrate(snapshot('win-9', 's1'))
    expect(useStore.getState().activeSessionByTask.t1).toBeUndefined()
  })

  it('re-hydrate keeps a still-hosted mark and the live window focus', () => {
    useStore.getState().hydrate(snapshot('main', 's1'))
    useStore.getState().setActiveSession('t1', 's2')
    useStore.getState().setWindowFocused(false)
    useStore.getState().hydrate(snapshot('main', 's3')) // e.g. the SettingsModal re-hydrate
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    expect(useStore.getState().windowFocused).toBe(false)
  })

  it('re-hydrate drops a mark that is no longer hosted here', () => {
    useStore.getState().hydrate(snapshot('main', 's2'))
    const moved = snapshot('main', 's1')
    const t1 = moved.tasks[0]
    const sessions = t1.sessions.map((x) => (x.id === 's2' ? { ...x, windowId: 'win-2' } : x))
    useStore.getState().hydrate({ ...moved, tasks: [{ ...t1, sessions }] })
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
  })

  it('taskCreated carrying sessions marks per window', () => {
    const t = snapshot('main', 's3').tasks[0]
    const main = reduceEvent(
      { ...initialData(), windowId: 'main' },
      { type: 'taskCreated', task: t }
    )
    const win2 = reduceEvent(
      { ...initialData(), windowId: 'win-2' },
      { type: 'taskCreated', task: t }
    )
    expect(main.activeSessionByTask.t1).toBe('s1')
    expect(win2.activeSessionByTask.t1).toBe('s3')
  })

  it('isSessionFocused follows THIS window’s mark, whatever the persisted pointer says', () => {
    useStore.getState().hydrate(snapshot('main', 's3'))
    const d = useStore.getState()
    expect(isSessionFocused(d, 's1')).toBe(true)
    expect(isSessionFocused(d, 's3')).toBe(false) // hosted elsewhere
    expect(isSessionFocused({ ...d, windowFocused: false }, 's1')).toBe(false)
  })

  it('setActiveSession does not mark a session hosted in another window', () => {
    useStore.getState().hydrate(snapshot('main', 's2'))
    useStore.getState().setActiveSession('t1', 's3')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
  })

  describe('sessionClosed', () => {
    it('closing the mark re-marks the LAST tab still in this window', () => {
      useStore.getState().hydrate(snapshot('main', 's1'))
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's1' })
      // s4 is the task's last session, but it lives in win-2.
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    })

    it('closing a session in another window leaves this window’s mark alone', () => {
      useStore.getState().hydrate(snapshot('main', 's1'))
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's3' })
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    })

    it('closing the window’s only tab leaves no mark', () => {
      useStore.getState().hydrate(snapshot('win-2', 's3'))
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's3' })
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's4' })
      expect(useStore.getState().activeSessionByTask.t1).toBeUndefined()
    })
  })

  describe('sessionMovedToWindow', () => {
    const move = (sessionId: string, fromWindowId: string, toWindowId: string) =>
      ({ type: 'sessionMovedToWindow', sessionId, taskId: 't1', fromWindowId, toWindowId }) as const

    it('the TARGET window marks the moved session', () => {
      useStore.getState().hydrate(snapshot('win-2', 's4'))
      useStore.getState().applyEvent(move('s1', 'main', 'win-2'))
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    })

    it('a "move to main" on window close keeps the target’s existing mark', () => {
      useStore.getState().hydrate(snapshot('main', 's2'))
      useStore.getState().applyEvent({ ...move('s3', 'win-2', 'main'), cause: 'windowClosed' })
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
      expect(useStore.getState().sessions.s3.windowId).toBe('main')
    })

    it('a "move to main" on window close marks the moved session if the target had none', () => {
      useStore.getState().hydrate(snapshot('win-9'))
      useStore.getState().applyEvent({ ...move('s3', 'win-2', 'win-9'), cause: 'windowClosed' })
      expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
    })

    it('the SOURCE re-marks the right neighbour when its mark moves out', () => {
      useStore.getState().hydrate(snapshot('main', 's1'))
      useStore.getState().applyEvent(move('s1', 'main', 'win-2'))
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    })

    it('the SOURCE re-marks the left neighbour when its rightmost mark moves out', () => {
      useStore.getState().hydrate(snapshot('main', 's2'))
      useStore.getState().applyEvent(move('s2', 'main', 'win-2'))
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    })

    it('the SOURCE drops its mark when its last tab moves out', () => {
      useStore.getState().hydrate(snapshot('win-2', 's3'))
      useStore.getState().applyEvent(move('s3', 'win-2', 'main'))
      useStore.getState().applyEvent(move('s4', 'win-2', 'main'))
      expect(useStore.getState().activeSessionByTask.t1).toBeUndefined()
    })

    it('moving a non-marked tab out keeps the source’s mark', () => {
      useStore.getState().hydrate(snapshot('main', 's1'))
      useStore.getState().applyEvent(move('s2', 'main', 'win-2'))
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    })

    it('a third window keeps its mark and just records the new host', () => {
      useStore.getState().hydrate(snapshot('main', 's1'))
      useStore.getState().applyEvent(move('s3', 'win-2', 'win-9'))
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
      expect(useStore.getState().sessions.s3.windowId).toBe('win-9')
    })

    /**
     * Whole-group moves (DESIGN §5.7 "every group member shares one window"): the
     * backend sends ONE event per member — the directly-sent one with no `cause`, the
     * rest tagged `cause: 'groupMove'` — but a single reducer step must move every
     * member's `windowId` atomically (IMP1 fix), or a groupmate whose own event hasn't
     * landed yet would misread as still hosted/on-screen here.
     */
    describe('group moves', () => {
      /** t1: s1+s2 grouped and s3 lone, all in `main`; s4 lone in `win-2`. */
      function groupedSnapshot(thisWindowId: string, active?: string): WindowedWorkspaceStateDTO {
        const base = snapshot(thisWindowId, active)
        const t1 = base.tasks[0]
        // The base snapshot hosts s3 in `win-2` alongside s4 — pull it into `main` so
        // there is a lone, non-group tab there to land on ("nearest OUTSIDE the group").
        const sessions = t1.sessions.map((x) => (x.id === 's3' ? { ...x, windowId: 'main' } : x))
        return { ...base, tasks: [{ ...t1, sessions, groups: [group('g1', leaf('s1'))] }] }
      }

      function withGroupLayout(layout: SplitNode): WindowedWorkspaceStateDTO {
        const s = groupedSnapshot('main', 's1')
        const t1 = s.tasks[0]
        return { ...s, tasks: [{ ...t1, groups: [group('g1', layout)] }] }
      }

      it('the source re-marks the nearest tab OUTSIDE the whole moving group, not a structural neighbour', () => {
        // Group g1 = {s1, s2}; s3 is lone, also in `main`. Marking s1 and moving it out
        // must land on s3 (outside the group), never s2 (a groupmate also leaving).
        useStore
          .getState()
          .hydrate(
            withGroupLayout({ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('s1'), b: leaf('s2') })
          )
        useStore.getState().applyEvent(move('s1', 'main', 'win-2'))
        expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
        // The whole group moved atomically: s2 (not directly sent) is already reassigned.
        expect(useStore.getState().sessions.s2.windowId).toBe('win-2')
      })

      it('the source re-marks OUTSIDE the group even when the mark is the OTHER member, not the one sent', () => {
        // Same group/snapshot, but the mark is s2 while s1 is the one directly sent. If
        // the source's "skip every current group member" logic keyed off whichever
        // member happens to be the mark (rather than group MEMBERSHIP), it would wrongly
        // fall through to a "lone session" structural-neighbour rule and land back on a
        // groupmate (s1 or s2) instead of skipping the whole group onto s3.
        useStore
          .getState()
          .hydrate(
            withGroupLayout({ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('s1'), b: leaf('s2') })
          )
        useStore.getState().setActiveSession('t1', 's2')
        useStore.getState().applyEvent(move('s1', 'main', 'win-2'))
        expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
        expect(useStore.getState().sessions.s2.windowId).toBe('win-2')
      })

      it('a group that is ALL of this window’s hosted tabs drops the mark — no transient focus of a groupmate', () => {
        // Unlike `groupedSnapshot`'s default (s3 pulled into `main` as a lone tab), drop
        // s3 from the task entirely here so s1+s2 (the group) is the WHOLE of `main`'s
        // hosted set — moving it out must leave no mark, and must NOT transiently
        // "focus" s2 on the way.
        const layout: SplitNode = {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: leaf('s1'),
          b: leaf('s2')
        }
        const s = withGroupLayout(layout)
        const t1 = s.tasks[0]
        // Drop s3 from `main` entirely so the group IS the window's whole tab set.
        const sessions = t1.sessions.filter((x) => x.id !== 's3')
        useStore.getState().hydrate({ ...s, tasks: [{ ...t1, sessions }] })

        useStore.getState().applyEvent(move('s1', 'main', 'win-2'))
        expect(useStore.getState().activeSessionByTask.t1).toBeUndefined()
        // s2 never becomes this window's mark/focus on the way out.
        expect(isSessionFocused(useStore.getState(), 's2')).toBe(false)
        expect(activeSessionInWindow(useStore.getState(), 't1', 'main')).toBeUndefined()

        // The second (tagged, cause: 'groupMove') event for the OTHER member that
        // already moved on the first event is an idempotent no-op.
        const before = useStore.getState()
        useStore.getState().applyEvent({ ...move('s2', 'main', 'win-2'), cause: 'groupMove' })
        expect(useStore.getState()).toBe(before)
      })

      it('a 3-member group moves atomically; the source skips every member when picking the nearest outside tab', () => {
        // row(a | col(b, c)) — three leaves, all hosted in `main` alongside lone s3... use
        // s1/s2/s4 as the group so s3 (lone, order 2) is the one surviving tab to land on.
        const layout: SplitNode = {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: leaf('s1'),
          b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('s2'), b: leaf('s4') }
        }
        const s = withGroupLayout(layout)
        const t1 = s.tasks[0]
        // Bring s4 into `main` too so all three group members share this window.
        const sessions = t1.sessions.map((x) =>
          x.id === 's4' ? { ...x, windowId: 'main', order: 3 } : x
        )
        useStore.getState().hydrate({ ...s, tasks: [{ ...t1, sessions }] })

        useStore.getState().applyEvent(move('s1', 'main', 'win-9'))
        expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
        expect(useStore.getState().sessions.s2.windowId).toBe('win-9')
        expect(useStore.getState().sessions.s4.windowId).toBe('win-9')
      })

      it('the TARGET marks the directly-sent member (no cause) even when it is a group', () => {
        // Hydrate FROM win-9's own vantage: it hosts none of t1's sessions yet, so it
        // has no mark to begin with (the group lives in `main`, per `withGroupLayout`).
        const s = withGroupLayout({
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: leaf('s1'),
          b: leaf('s2')
        })
        useStore.getState().hydrate({ ...s, thisWindowId: 'win-9', thisWindowRole: 'secondary' })
        expect(useStore.getState().activeSessionByTask.t1).toBeUndefined()
        useStore.getState().applyEvent(move('s1', 'main', 'win-9'))
        expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
      })

      it('the TARGET marks whichever member was directly sent, even if not the group’s first member', () => {
        // Same as above, but s2 — not s1, the "first" member in both the tree a/b order
        // and tab order — is the one actually sent. A target-side rule hardcoded to "mark
        // the group's first member" would wrongly mark s1 instead of the member that was
        // truly moved.
        const s = withGroupLayout({
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: leaf('s1'),
          b: leaf('s2')
        })
        useStore.getState().hydrate({ ...s, thisWindowId: 'win-9', thisWindowRole: 'secondary' })
        expect(useStore.getState().activeSessionByTask.t1).toBeUndefined()
        useStore.getState().applyEvent(move('s2', 'main', 'win-9'))
        expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
      })

      it('the TARGET keeps its existing mark for a tagged (cause: groupMove) rider', () => {
        // Hydrate FROM win-2's own vantage: it already hosts and marks lone s4 (per the
        // base `snapshot`); a tagged rider of the main-side group move must not disturb it.
        const s = withGroupLayout({
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: leaf('s1'),
          b: leaf('s2')
        })
        useStore.getState().hydrate({ ...s, thisWindowId: 'win-2', thisWindowRole: 'secondary' })
        expect(useStore.getState().activeSessionByTask.t1).toBe('s4')
        useStore.getState().applyEvent({ ...move('s2', 'main', 'win-2'), cause: 'groupMove' })
        expect(useStore.getState().activeSessionByTask.t1).toBe('s4')
      })
    })
  })
})

/** Focus flash (§5.4): moving INTO a window flashes its marked tab for FOCUS_FLASH_MS. */
describe('focus flash (§5.4)', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  const focus = (f: boolean): void => useStore.getState().setWindowFocused(f)

  it('the window’s first focus (it just appeared) does not flash', () => {
    focus(false) // mount seed of a not-yet-shown window
    focus(true)
    expect(useStore.getState().focusFlashOn).toBe(false)
  })

  it('the mount seed of an already-focused window does not flash', () => {
    focus(true)
    expect(useStore.getState().focusFlashOn).toBe(false)
    expect(useStore.getState().windowFocusedOnce).toBe(true)
  })

  it('moving back INTO a window flashes; blur ends it', () => {
    focus(true)
    focus(false)
    focus(true)
    expect(useStore.getState().focusFlashOn).toBe(true)
    expect(useStore.getState().focusFlashSeq).toBe(1)
    focus(false)
    expect(useStore.getState().focusFlashOn).toBe(false)
  })

  it('a repeated focus while focused does not re-arm', () => {
    focus(true)
    focus(false)
    focus(true)
    focus(true)
    expect(useStore.getState().focusFlashSeq).toBe(1)
  })

  it('a focus event trailing an already-armed flash does not restart it', () => {
    // activeSessionChanged armed it while this host was still blurred (the raise in flight).
    useStore.setState({
      windowFocused: false,
      windowFocusedOnce: true,
      focusFlashOn: true,
      focusFlashSeq: 4
    })
    focus(true)
    expect(useStore.getState().focusFlashOn).toBe(true)
    expect(useStore.getState().focusFlashSeq).toBe(4)
  })

  it('endFocusFlash ends only the current flash', () => {
    useStore.setState({ focusFlashOn: true, focusFlashSeq: 2 })
    useStore.getState().endFocusFlash(1) // stale timer
    expect(useStore.getState().focusFlashOn).toBe(true)
    useStore.getState().endFocusFlash(2)
    expect(useStore.getState().focusFlashOn).toBe(false)
  })
})

/**
 * Ready-for-review (§9.5): a pure renderer view-model derived from the state stream.
 * Raised UNCONDITIONALLY on `working → waiting`; the dot is suppressed at display time
 * while on screen, and the flag is cleared when the session is brought on screen (focus
 * transition) OR watched in place (`markVisibleSessionSeen`) OR leaves idle.
 */
describe('ready-for-review (§9.5)', () => {
  /** A store with one task `t1` holding sessions `s1`,`s2`, both in the main window. */
  function base(): StoreData {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    // sessionCreated makes the last-created session the active tab; force a known focus.
    return { ...d, activeTaskId: 't1', activeSessionByTask: { t1: 's1' }, windowFocused: true }
  }

  const setState = (d: StoreData, id: string, state: string): StoreData =>
    reduceEvent(d, { type: 'sessionStateChanged', sessionId: id, state })

  it('raises the flag on working → waiting for an unfocused session', () => {
    let d = base() // s1 is focused, s2 is not
    d = setState(d, 's2', 'working')
    d = setState(d, 's2', 'waiting')
    expect(d.hasUnseenFinishedTurn.s2).toBe(true)
    // s2 is idle with the flag AND off screen → the task rollup surfaces `review`
    // (s1 still unknown).
    expect(taskDisplayState(d, 't1')).toBe('review')
  })

  it('raises for the FOCUSED session too, but display suppresses the dot while on screen', () => {
    // The raise is UNCONDITIONAL (§9.5): the on-screen decision moves to display time so
    // a transient turn-end focus misread on the VDI host can't leave a stuck dot. So the
    // flag IS set even for the session the user is looking at — but `sessionDisplayState`
    // (and the task rollup) suppress `review` for an on-screen session.
    let d = base() // s1 focused
    d = setState(d, 's1', 'working')
    d = setState(d, 's1', 'waiting')
    expect(d.hasUnseenFinishedTurn.s1).toBe(true) // raised regardless of focus
    // On screen → suppressed to idle both per-session and in the rollup.
    expect(sessionDisplayState(d.sessions.s1, true, isSessionFocused(d, 's1'))).toBe('idle')
    expect(taskDisplayState(d, 't1')).toBe('idle')
  })

  it('does NOT raise on blocked → waiting (an answered prompt is not new finished work)', () => {
    let d = base()
    d = setState(d, 's2', 'blocked')
    d = setState(d, 's2', 'waiting')
    expect(d.hasUnseenFinishedTurn.s2).toBeUndefined()
  })

  it('does NOT raise on a straight-to-waiting with no prior working (fresh prompt)', () => {
    let d = base()
    d = setState(d, 's2', 'waiting')
    expect(d.hasUnseenFinishedTurn.s2).toBeUndefined()
  })

  it('raises for the active tab when its OWN window is blurred', () => {
    let d = { ...base(), windowFocused: false }
    d = setState(d, 's1', 'working') // s1 is the active tab, but window is blurred
    d = setState(d, 's1', 'waiting')
    expect(d.hasUnseenFinishedTurn.s1).toBe(true)
  })

  it('raises for the active tab of a task the user has switched AWAY from', () => {
    // s1 is s1-task's active tab, but the user is now viewing a different task, so
    // s1 is off screen and finishing there is "just finished, unlooked" (§9.5).
    let d: StoreData = { ...base(), activeTaskId: 't-other' }
    d = setState(d, 's1', 'working')
    d = setState(d, 's1', 'waiting')
    expect(d.hasUnseenFinishedTurn.s1).toBe(true)
  })

  it('isSessionFocused reflects active-task + active-tab + this-window + window-focus', () => {
    const d = base()
    expect(isSessionFocused(d, 's1')).toBe(true)
    expect(isSessionFocused(d, 's2')).toBe(false)
    expect(isSessionFocused({ ...d, windowFocused: false }, 's1')).toBe(false)
    // s1 is its task's active tab, but that task is not the viewed task → unfocused.
    expect(isSessionFocused({ ...d, activeTaskId: 't-other' }, 's1')).toBe(false)
  })

  it('setActiveSession clears the flag on the newly-focused session', () => {
    useStore.setState({ ...base(), hasUnseenFinishedTurn: { s2: true } })
    useStore.getState().setActiveSession('t1', 's2')
    expect(useStore.getState().hasUnseenFinishedTurn.s2).toBeUndefined()
  })

  it('regaining window focus leaves the clear to markVisibleSessionSeen, which relays it (§9.5)', () => {
    // A local clear here would swallow the cross-window `sessions.markSeen` relay, so the
    // main window's rollup could stay lit for a session the user focused in another window.
    useStore.setState({
      ...base(),
      windowFocused: false,
      windowFocusedOnce: true,
      hasUnseenFinishedTurn: { s1: true }
    })
    useStore.getState().setWindowFocused(true)
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBe(true)
    expect(useStore.getState().markVisibleSessionSeen()).toBe('s1')
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBeUndefined()
  })

  it('markVisibleSessionSeen clears the flag for a turn finished IN PLACE while watched (§9.5)', () => {
    // s1 is the on-screen tab of the focused window; it finished in place, so no focus
    // transition fired to mark it seen. The App effect calls markVisibleSessionSeen on
    // the settled render → the flag clears, so the dot won't resurface on switch-away.
    // It also RETURNS the cleared id so the App effect can relay "seen" cross-window.
    useStore.setState({ ...base(), hasUnseenFinishedTurn: { s1: true } })
    const cleared = useStore.getState().markVisibleSessionSeen()
    expect(cleared).toBe('s1')
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBeUndefined()
  })

  it('markVisibleSessionSeen returns undefined when there is nothing on screen to clear', () => {
    // Nothing flagged → no clear, no id to relay (App effect skips the markSeen IPC).
    useStore.setState({ ...base() })
    expect(useStore.getState().markVisibleSessionSeen()).toBeUndefined()
    // Blurred: the visible session is not on screen → no clear, no relay.
    useStore.setState({ ...base(), windowFocused: false, hasUnseenFinishedTurn: { s1: true } })
    expect(useStore.getState().markVisibleSessionSeen()).toBeUndefined()
  })

  it('sessionSeen event clears the flag (cross-window watch-in-place relay, §9.5)', () => {
    // The main window folds the task rollup over sessions in ANY window but knows only
    // its own focus, so a turn watched to idle in a SECONDARY window can't be suppressed
    // by the display-time gate here. The hosting window relays `sessions.markSeen`, main
    // broadcasts `sessionSeen`, and THIS window clears the flag so the rollup drops
    // `review`. Model s2 as a session hosted elsewhere: flagged + idle → rolls up review.
    let d: StoreData = {
      ...base(),
      sessions: {
        ...base().sessions,
        s2: { ...base().sessions.s2, state: 'waiting', windowId: 'w-other' }
      },
      hasUnseenFinishedTurn: { s2: true }
    }
    expect(taskDisplayState(d, 't1')).toBe('review')
    d = reduceEvent(d, { type: 'sessionSeen', sessionId: 's2' })
    expect(d.hasUnseenFinishedTurn.s2).toBeUndefined()
    expect(taskDisplayState(d, 't1')).toBe('idle')
  })

  it('sessionSeen event is a no-op for a session with no flag (idempotent relay)', () => {
    const d = base()
    expect(reduceEvent(d, { type: 'sessionSeen', sessionId: 's1' })).toBe(d)
  })

  it('markVisibleSessionSeen does NOT clear when the window is blurred (not on screen)', () => {
    useStore.setState({ ...base(), windowFocused: false, hasUnseenFinishedTurn: { s1: true } })
    useStore.getState().markVisibleSessionSeen()
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBe(true)
  })

  it('markVisibleSessionSeen does NOT clear an off-screen flagged session (not the active tab)', () => {
    // s2 is flagged but s1 is the active tab, so s2 is off screen → its cue must stand.
    useStore.setState({ ...base(), hasUnseenFinishedTurn: { s2: true } })
    useStore.getState().markVisibleSessionSeen()
    expect(useStore.getState().hasUnseenFinishedTurn.s2).toBe(true)
  })

  it('markVisibleSessionSeen does NOT clear when a different task is on screen', () => {
    // s1 is its task's active tab, but the user is viewing another task → s1 off screen.
    useStore.setState({ ...base(), activeTaskId: 't-other', hasUnseenFinishedTurn: { s1: true } })
    useStore.getState().markVisibleSessionSeen()
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBe(true)
  })

  it('closing a session drops any lingering flag', () => {
    let d: StoreData = { ...base(), hasUnseenFinishedTurn: { s2: true } }
    d = reduceEvent(d, { type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
    expect(d.hasUnseenFinishedTurn.s2).toBeUndefined()
  })

  it('task rollup clears when a session hosted in ANOTHER window is focused there (§9.5)', () => {
    // Regression: the main window renders the task rollup but its sessions can live in
    // other windows. Focusing such a session broadcasts `activeSessionChanged` with a
    // non-host windowId; the (main) window must still clear the flag so the task dot
    // stops showing ready-for-review with no session actually flagged.
    // s2 is idle (waiting) AND flagged → it rolls up as `review` until focus clears it.
    let d: StoreData = {
      ...base(),
      sessions: { ...base().sessions, s2: { ...base().sessions.s2, state: 'waiting' } },
      hasUnseenFinishedTurn: { s2: true }
    }
    // Move s2 out to a secondary window, as a detach would.
    d = reduceEvent(d, {
      type: 'sessionMovedToWindow',
      sessionId: 's2',
      taskId: 't1',
      fromWindowId: 'main',
      toWindowId: 'win-2'
    })
    expect(taskDisplayState(d, 't1')).toBe('review')
    d = reduceEvent(d, {
      type: 'activeSessionChanged',
      taskId: 't1',
      sessionId: 's2',
      windowId: 'win-2'
    })
    expect(d.hasUnseenFinishedTurn.s2).toBeUndefined()
    // Flag cleared, s2 still idle → the rollup falls back to plain idle, not review.
    expect(taskDisplayState(d, 't1')).toBe('idle')
  })

  it('activeTaskChanged leaves the flag; the focused window clears its on-screen mark (§9.5)', () => {
    // Switching BACK to a task (not between its sessions) must clear the dot. Each window
    // shows its OWN mark for the task, and only the focused window's is looked at, so the
    // reducer can't pick the session — the settled-render markVisibleSessionSeen does.
    // Model "away on t-other, then switch to t1" in the focused window.
    let d: StoreData = {
      ...base(),
      sessions: { ...base().sessions, s1: { ...base().sessions.s1, state: 'waiting' } },
      activeTaskId: 't-other',
      hasUnseenFinishedTurn: { s1: true }
    }
    d = reduceEvent(d, { type: 'activeTaskChanged', taskId: 't1' })
    expect(d.activeTaskId).toBe('t1')
    expect(d.hasUnseenFinishedTurn.s1).toBe(true)
    // On screen → the dot is already suppressed at display time...
    expect(taskDisplayState(d, 't1')).toBe('idle')
    // ...and the settled-render effect clears (and relays) it.
    useStore.setState(d)
    expect(useStore.getState().markVisibleSessionSeen()).toBe('s1')
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBeUndefined()
  })

  it('activeTaskChanged does NOT mark a blurred window’s tab seen (§9.5)', () => {
    // The task becomes visible in every window, but a blurred window's mark is not being
    // looked at: its flag stays and the dot shows (until the user looks or it's relayed).
    let d: StoreData = {
      ...base(),
      sessions: { ...base().sessions, s1: { ...base().sessions.s1, state: 'waiting' } },
      windowId: 'main',
      windowFocused: false,
      activeTaskId: 't-other',
      hasUnseenFinishedTurn: { s1: true }
    }
    d = reduceEvent(d, { type: 'activeTaskChanged', taskId: 't1' })
    expect(d.hasUnseenFinishedTurn.s1).toBe(true)
    expect(taskDisplayState(d, 't1')).toBe('review')
    useStore.setState(d)
    expect(useStore.getState().markVisibleSessionSeen()).toBeUndefined()
  })

  it('activeTaskChanged with an undefined taskId leaves flags untouched', () => {
    let d: StoreData = { ...base(), hasUnseenFinishedTurn: { s1: true } }
    d = reduceEvent(d, { type: 'activeTaskChanged', taskId: undefined })
    expect(d.activeTaskId).toBeUndefined()
    expect(d.hasUnseenFinishedTurn.s1).toBe(true) // no active session to clear
  })

  it('activeTaskChanged for a task with no active-session pointer preserves flags', () => {
    let d: StoreData = { ...base(), activeSessionByTask: {}, hasUnseenFinishedTurn: { s1: true } }
    d = reduceEvent(d, { type: 'activeTaskChanged', taskId: 't1' })
    expect(d.activeTaskId).toBe('t1')
    expect(d.hasUnseenFinishedTurn.s1).toBe(true)
  })

  it('setActiveTask leaves the clear to markVisibleSessionSeen, which relays it (§9.5)', () => {
    useStore.setState({ ...base(), activeTaskId: 't-other', hasUnseenFinishedTurn: { s1: true } })
    useStore.getState().setActiveTask('t1')
    expect(useStore.getState().activeTaskId).toBe('t1')
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBe(true)
    expect(useStore.getState().markVisibleSessionSeen()).toBe('s1')
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBeUndefined()
  })

  it('setActiveTask preserves flags when the task has no active session', () => {
    useStore.setState({ ...base(), activeSessionByTask: {}, hasUnseenFinishedTurn: { s1: true } })
    useStore.getState().setActiveTask('t1')
    expect(useStore.getState().hasUnseenFinishedTurn.s1).toBe(true)
  })

  it('a resumed session (waiting→working) drops its stale flag — the bug repro (§9.5)', () => {
    // Claude finishes (working→waiting) while s2 is unfocused → flag raised → shows
    // review. Then Claude resumes (waiting→working) before the user looks: the newer
    // `working` must win, and the store must drop the now-invalid flag.
    let d = base() // s1 focused, s2 unfocused
    d = setState(d, 's2', 'working')
    d = setState(d, 's2', 'waiting')
    expect(d.hasUnseenFinishedTurn.s2).toBe(true)
    expect(sessionDisplayState(d.sessions.s2, true, isSessionFocused(d, 's2'))).toBe('review')
    d = setState(d, 's2', 'working') // Claude resumed
    expect(d.hasUnseenFinishedTurn.s2).toBeUndefined() // defense-in-depth clear
    expect(
      sessionDisplayState(
        d.sessions.s2,
        d.hasUnseenFinishedTurn.s2 === true,
        isSessionFocused(d, 's2')
      )
    ).toBe('working')
    expect(taskDisplayState(d, 't1')).toBe('working')
  })

  it('leaving waiting for blocked also drops a stale flag (§9.5)', () => {
    let d: StoreData = {
      ...base(),
      sessions: { ...base().sessions, s2: { ...base().sessions.s2, state: 'waiting' } },
      hasUnseenFinishedTurn: { s2: true }
    }
    d = setState(d, 's2', 'blocked')
    expect(d.hasUnseenFinishedTurn.s2).toBeUndefined()
    expect(sessionDisplayState(d.sessions.s2, false, false)).toBe('needsInput')
  })
})

/**
 * Display-state derivation (§3.4/§9.5): the icon a session/task shows is the highest-
 * priority display level — `needsInput > review > working > idle > none` — where
 * `review` is valid only while the session is idle (folds the finished-unseen flag)
 * AND the session is NOT on screen (the on-screen check is applied here, at display
 * time). `sessionDisplayState(session, hasUnseenFinishedTurn, isOnScreen)`.
 */
describe('display state (§3.4/§9.5)', () => {
  const sess = (over: Partial<SessionDTO>): SessionDTO => session('s', 't', over)

  it('a working session ignores a stale review flag → working (not review)', () => {
    expect(sessionDisplayState(sess({ state: 'working' }), true, false)).toBe('working')
  })

  it('a blocked session + review flag → needsInput (attention beats a finished sibling)', () => {
    expect(sessionDisplayState(sess({ state: 'blocked' }), true, false)).toBe('needsInput')
  })

  it('review is valid only while idle: waiting + flag (off screen) → review, without flag → idle', () => {
    expect(sessionDisplayState(sess({ state: 'waiting' }), true, false)).toBe('review')
    expect(sessionDisplayState(sess({ state: 'waiting' }), false, false)).toBe('idle')
  })

  it('on-screen gate: an idle + flagged session that is ON screen → idle (dot suppressed)', () => {
    // The core VDI fix (§9.5/§9.7): review is decided at display time, so a session the
    // user is currently looking at never shows the dot even with the flag raised.
    expect(sessionDisplayState(sess({ state: 'waiting' }), true, true)).toBe('idle')
  })

  it('unknown → none (no icon), even with a flag', () => {
    expect(sessionDisplayState(sess({ state: 'unknown' }), true, false)).toBe('none')
  })

  it('an exited/failed session contributes needsInput (I12), flag or not', () => {
    expect(sessionDisplayState(sess({ lifecycle: 'exited', state: 'waiting' }), true, false)).toBe(
      'needsInput'
    )
    expect(
      sessionDisplayState(sess({ lifecycle: 'start_failed', state: 'unknown' }), false, false)
    ).toBe('needsInput')
  })

  /** A task `t1` with two sessions in given states + flags. */
  function taskWith(
    s1: Partial<SessionDTO>,
    s2: Partial<SessionDTO>,
    ready: Record<string, boolean> = {}
  ): StoreData {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1', s1) })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1', s2) })
    return { ...d, hasUnseenFinishedTurn: ready }
  }

  it('rollup: review on one session beats working on another → review', () => {
    const d = taskWith({ state: 'waiting' }, { state: 'working' }, { s1: true })
    expect(taskDisplayState(d, 't1')).toBe('review')
  })

  it('rollup: needsInput anywhere beats a review sibling → needsInput', () => {
    const d = taskWith({ state: 'waiting' }, { state: 'blocked' }, { s1: true })
    expect(taskDisplayState(d, 't1')).toBe('needsInput')
  })

  it('rollup: a flagged idle session ON screen does NOT roll review onto its task', () => {
    // Same VDI display-time gate at the task level (§9.5): if the flagged session is the
    // active tab of the (focused) window, the rollup must fall back to idle, not review.
    const d: StoreData = {
      ...taskWith({ state: 'waiting' }, { state: 'unknown' }, { s1: true }),
      activeTaskId: 't1',
      windowFocused: true,
      activeSessionByTask: { t1: 's1' }
    }
    expect(isSessionFocused(d, 's1')).toBe(true)
    expect(taskDisplayState(d, 't1')).toBe('idle')
  })

  it('rollup: a working session with a stale flag alongside another working → working', () => {
    const d = taskWith({ state: 'working' }, { state: 'working' }, { s1: true })
    expect(taskDisplayState(d, 't1')).toBe('working')
  })

  it('rollup: an empty / all-unknown task → none', () => {
    const empty = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    expect(taskDisplayState(empty, 't1')).toBe('none')
    const unknowns = taskWith({ state: 'unknown' }, { state: 'unknown' })
    expect(taskDisplayState(unknowns, 't1')).toBe('none')
  })

  it('rollup: an unknown task id → none', () => {
    expect(taskDisplayState(initialData(), 'nope')).toBe('none')
  })
})

describe('debug-overlay transition ring (§11)', () => {
  function base(): StoreData {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    return d
  }

  it('appends each transition with from/to and forwarded layer/reason metadata', () => {
    let d = base()
    d = reduceEvent(d, {
      type: 'sessionStateChanged',
      sessionId: 's1',
      state: 'working',
      layer: 3,
      confidence: 'authoritative',
      reason: 'claude_working'
    })
    expect(d.debugTransitions).toHaveLength(1)
    expect(d.debugTransitions[0]).toMatchObject({
      sessionId: 's1',
      from: 'unknown',
      to: 'working',
      layer: 3,
      confidence: 'authoritative',
      reason: 'claude_working'
    })
  })

  it('assigns a monotonic seq and records the prior state as `from`', () => {
    let d = base()
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'working' })
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'waiting' })
    expect(d.debugTransitions.map((t) => ({ seq: t.seq, from: t.from, to: t.to }))).toEqual([
      { seq: 1, from: 'unknown', to: 'working' },
      { seq: 2, from: 'working', to: 'waiting' }
    ])
  })

  it('caps the ring at DEBUG_RING_CAPACITY, evicting the oldest', () => {
    let d = base()
    for (let i = 0; i < 250; i++) {
      d = reduceEvent(d, {
        type: 'sessionStateChanged',
        sessionId: 's1',
        state: i % 2 === 0 ? 'working' : 'waiting'
      })
    }
    expect(d.debugTransitions).toHaveLength(200)
    // The oldest retained is seq 51 (250 total, keep the last 200).
    expect(d.debugTransitions[0].seq).toBe(51)
    expect(d.debugTransitions[d.debugTransitions.length - 1].seq).toBe(250)
  })

  it('does not record for an unknown session id', () => {
    let d = base()
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 'ghost', state: 'working' })
    expect(d.debugTransitions).toHaveLength(0)
  })

  it('toggleDebugOverlay flips the flag', () => {
    useStore.setState(initialData())
    expect(useStore.getState().debugOverlayOpen).toBe(false)
    useStore.getState().toggleDebugOverlay()
    expect(useStore.getState().debugOverlayOpen).toBe(true)
    useStore.getState().toggleDebugOverlay()
    expect(useStore.getState().debugOverlayOpen).toBe(false)
  })
})

describe('sessionStateNotification → toast (§9.5)', () => {
  it('pushes one info toast: bold "State changed" title over a task-session body', () => {
    const d = reduceEvent(initialData(), {
      type: 'sessionStateNotification',
      sessionId: 's1',
      taskName: 'Refactor auth',
      sessionName: 'claude'
    })
    expect(d.toasts).toHaveLength(1)
    expect(d.toasts[0].kind).toBe('info')
    // Bold title + names body, no old/new state (§9.5).
    expect(d.toasts[0].title).toBe('State changed')
    expect(d.toasts[0].message).toBe('Refactor auth - claude')
  })

  // Suppression (§9.5): "if I can see Claude myself, I don't need a toast." A store
  // with task `t1`, sessions `s1`(active tab)/`s2`, both in the main window, focused.
  function viewing(): StoreData {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    return { ...d, activeTaskId: 't1', activeSessionByTask: { t1: 's1' }, windowFocused: true }
  }

  const notify = (d: StoreData, sessionId: string): StoreData =>
    reduceEvent(d, {
      type: 'sessionStateNotification',
      sessionId,
      taskName: 'T',
      sessionName: 'S'
    })

  it('SUPPRESSES the toast when the changed session is the one on screen', () => {
    // s1 is the focused, on-screen session — the tab icon already shows the change.
    expect(notify(viewing(), 's1').toasts).toHaveLength(0)
  })

  it('still notifies for a background tab in the same (viewed) task', () => {
    // s2 is in the viewed task but is not the active tab → off screen → notify.
    expect(notify(viewing(), 's2').toasts).toHaveLength(1)
  })

  it('still notifies when the hosting window is blurred, even for the active tab', () => {
    const blurred = { ...viewing(), windowFocused: false }
    expect(notify(blurred, 's1').toasts).toHaveLength(1)
  })

  it('still notifies when the user has switched to a different task', () => {
    const away = { ...viewing(), activeTaskId: 't-other' }
    expect(notify(away, 's1').toasts).toHaveLength(1)
  })

  it('drops the toast when the throttle rejects the (would-be-shown) change', () => {
    // A rejecting `admit` (session still hot from the last shown toast) suppresses the
    // toast even though focus does NOT suppress it. Only consulted after the focus check.
    const away = { ...viewing(), activeTaskId: 't-other' }
    const d = reduceEvent(
      away,
      { type: 'sessionStateNotification', sessionId: 's1', taskName: 'T', sessionName: 'S' },
      () => false
    )
    expect(d.toasts).toHaveLength(0)
  })

  it('does NOT consult the throttle for a focus-suppressed change (window stays cold)', () => {
    // The changed session is on screen → focus suppresses BEFORE `admit`. If `admit` were
    // consulted it would have armed the window; assert it is never called here.
    let admitCalls = 0
    const d = reduceEvent(
      viewing(),
      { type: 'sessionStateNotification', sessionId: 's1', taskName: 'T', sessionName: 'S' },
      () => {
        admitCalls++
        return true
      }
    )
    expect(d.toasts).toHaveLength(0)
    expect(admitCalls).toBe(0)
  })
})

describe('default settings include the six split-pane chords (DESIGN §5.7)', () => {
  it('initialData().settings carries the default split/focus-pane chords', () => {
    const s = initialData().settings
    expect(s.splitRightKey).toBe('Ctrl+Shift+KeyE')
    expect(s.splitDownKey).toBe('Ctrl+Shift+KeyO')
    expect(s.focusPaneLeftKey).toBe('Ctrl+Shift+KeyH')
    expect(s.focusPaneRightKey).toBe('Ctrl+Shift+KeyL')
    expect(s.focusPaneUpKey).toBe('Ctrl+Shift+KeyK')
    expect(s.focusPaneDownKey).toBe('Ctrl+Shift+KeyJ')
  })
})

/**
 * Split groups (DESIGN §5.7, split-groups design): `groupsByTask` is the backend-owned
 * projection of each task's `GroupDTO[]` (hydrate's `TaskDTO.groups`, replaced wholesale
 * on `groupsChanged`); the renderer never mutates a group, only reads it via
 * {@link groupOfSession}. Mark moves (`setActiveSession`, `focusPane`) and group
 * membership are orthogonal — the mark-move actions never touch a group (DESIGN §3.7).
 */
describe('split groups (DESIGN §5.7, split-groups design)', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  /** t1 with s1, s2, s3 all hosted in `main`, grouped as g1 = row(s1 | s2); s3 lone. */
  function groupedBase(): StoreData {
    let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s3', 't1') })
    const layout: SplitNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: leaf('s1'),
      b: leaf('s2')
    }
    d = reduceEvent(d, { type: 'groupsChanged', taskId: 't1', groups: [group('g1', layout)] })
    return { ...d, activeTaskId: 't1', activeSessionByTask: { t1: 's1' }, windowFocused: true }
  }

  describe('groupsByTask: hydrate + groupsChanged + groupOfSession', () => {
    it('hydrate seeds groupsByTask from each TaskDTO.groups', () => {
      const layout: SplitNode = {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: leaf('s1'),
        b: leaf('s2')
      }
      const state: WindowedWorkspaceStateDTO = {
        tasks: [
          task('t1', {
            sessions: [session('s1', 't1'), session('s2', 't1')],
            groups: [group('g1', layout)]
          })
        ],
        activeTaskId: 't1',
        sessionTypes: [],
        settings: initialData().settings,
        version: 1,
        thisWindowId: 'main',
        thisWindowRole: 'main',
        windows: [],
        issues: []
      }
      useStore.getState().hydrate(state)
      expect(useStore.getState().groupsByTask.t1).toEqual([group('g1', layout)])
    })

    it('groupsChanged replaces a task’s group list wholesale', () => {
      const d = groupedBase()
      const next = reduceEvent(d, { type: 'groupsChanged', taskId: 't1', groups: [] })
      expect(next.groupsByTask.t1).toEqual([])
      expect(groupOfSession(next, 't1', 's1')).toBeUndefined()
    })

    it('groupsChanged for an unknown task is a no-op (identity)', () => {
      const d = groupedBase()
      const next = reduceEvent(d, {
        type: 'groupsChanged',
        taskId: 'ghost-task',
        groups: [group('g9', leaf('s9'))]
      })
      expect(next).toBe(d)
      expect(next.groupsByTask['ghost-task']).toBeUndefined()
    })

    it('groupOfSession finds the group containing a leaf; undefined for a lone session', () => {
      const d = groupedBase()
      expect(groupOfSession(d, 't1', 's1')?.id).toBe('g1')
      expect(groupOfSession(d, 't1', 's2')?.id).toBe('g1')
      expect(groupOfSession(d, 't1', 's3')).toBeUndefined() // lone
      expect(groupOfSession(d, 'ghost-task', 's1')).toBeUndefined()
    })
  })

  describe('mark moves never touch a group', () => {
    it('setActiveSession (tab click) moves the mark only — groupsByTask is untouched', () => {
      useStore.setState(groupedBase())
      const before = useStore.getState().groupsByTask
      useStore.getState().setActiveSession('t1', 's2')
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
      expect(useStore.getState().groupsByTask).toBe(before) // same reference: untouched
      expect(groupOfSession(useStore.getState(), 't1', 's2')?.id).toBe('g1') // still grouped
    })

    it('focusPane moves the mark only — groupsByTask is untouched', () => {
      useStore.setState(groupedBase())
      const before = useStore.getState().groupsByTask
      useStore.getState().focusPane('s2')
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
      expect(useStore.getState().groupsByTask).toBe(before)
    })

    it('focusPane into a lone session leaves it lone (no implicit group join)', () => {
      useStore.setState(groupedBase())
      useStore.getState().focusPane('s3')
      expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
      expect(groupOfSession(useStore.getState(), 't1', 's3')).toBeUndefined()
    })
  })

  describe('closing a grouped tab re-marks within the group (§3.7, IMP3 fix)', () => {
    it('closing the focused FIRST member marks the NEXT groupmate', () => {
      useStore.setState({ ...groupedBase(), activeSessionByTask: { t1: 's1' } })
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's1' })
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    })

    it('closing the focused LAST member marks the PREVIOUS groupmate', () => {
      useStore.setState({ ...groupedBase(), activeSessionByTask: { t1: 's2' } })
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    })

    /**
     * A 3-member group whose TREE a/b order deliberately disagrees with TAB order, to
     * prove `neighbourInGroup` (store.ts) walks `fullOrder` (tab order), not the tree's
     * structural a/b order. Tree DFS order: s3, s1, s2. Tab order (the `order` field,
     * sorted by `normalizeTask` on hydrate): s1, s2, s3.
     */
    function threeMemberDivergentOrderState(): WindowedWorkspaceStateDTO {
      const layout: SplitNode = {
        kind: 'split',
        dir: 'row',
        ratio: 0.5,
        a: leaf('s3'),
        b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('s1'), b: leaf('s2') }
      }
      return {
        tasks: [
          task('t1', {
            sessions: [
              session('s1', 't1', { order: 0 }),
              session('s2', 't1', { order: 1 }),
              session('s3', 't1', { order: 2 })
            ],
            groups: [group('g1', layout)]
          })
        ],
        activeTaskId: 't1',
        sessionTypes: [],
        settings: initialData().settings,
        version: 1,
        thisWindowId: 'main',
        thisWindowRole: 'main',
        windows: [],
        issues: []
      }
    }

    it('closing the TAB-order-MIDDLE member marks the TAB-order-next groupmate, not the tree-order one', () => {
      // s2 is tab-order-middle (order 1) but tree-order-LAST (DFS: s3, s1, s2). A rule
      // that walked the tree's a/b order (ignoring `fullOrder`) would see s2 as last and
      // land on tree-previous s1; the correct tab-order-next is s3.
      useStore.getState().hydrate(threeMemberDivergentOrderState())
      useStore.getState().setActiveSession('t1', 's2')
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
      expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
    })

    it('closing the TAB-order-LAST member marks the TAB-order-previous groupmate, not the tree-order one', () => {
      // s3 is tab-order-LAST (order 2) but tree-order-FIRST (DFS: s3, s1, s2). A rule
      // keyed off tree order (ignoring `fullOrder`) would see s3 as first and land on
      // tree-next s1; the correct tab-order-previous is s2.
      useStore.getState().hydrate(threeMemberDivergentOrderState())
      useStore.getState().setActiveSession('t1', 's3')
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's3' })
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    })

    it('a group of 2 losing a member, then groupsChanged, dissolves the group', () => {
      // Start with g1 = {s1, s2} only (drop lone s3 so the group IS the whole task).
      let d = reduceEvent(initialData(), { type: 'taskCreated', task: task('t1') })
      d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
      d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
      const layout: SplitNode = {
        kind: 'split',
        dir: 'row',
        ratio: 0.5,
        a: leaf('s1'),
        b: leaf('s2')
      }
      d = reduceEvent(d, { type: 'groupsChanged', taskId: 't1', groups: [group('g1', layout)] })
      d = { ...d, activeTaskId: 't1', activeSessionByTask: { t1: 's1' } }

      // Close s1: sessionClosed arrives BEFORE groupsChanged (§5.7), so the OLD group
      // (still 2 members) decides the re-mark — s2, the sole remaining groupmate.
      d = reduceEvent(d, { type: 'sessionClosed', taskId: 't1', sessionId: 's1' })
      expect(d.activeSessionByTask.t1).toBe('s2')
      expect(d.groupsByTask.t1).toEqual([group('g1', layout)]) // not yet reconciled

      // The backend then reconciles: a 1-member "group" isn't a group (DESIGN §5.7).
      d = reduceEvent(d, { type: 'groupsChanged', taskId: 't1', groups: [] })
      expect(d.groupsByTask.t1).toEqual([])
      expect(groupOfSession(d, 't1', 's2')).toBeUndefined() // s2 is lone now
      expect(d.activeSessionByTask.t1).toBe('s2') // the re-mark survives dissolution
    })
  })

  describe('hydrate: initialMark (§6.7 IMP2 fix) vs. a per-window mark vs. the persisted pointer', () => {
    function stateWith(
      initialMark: { taskId: string; sessionId: string } | undefined
    ): WindowedWorkspaceStateDTO {
      return {
        tasks: [
          task('t1', {
            sessions: [session('s1', 't1'), session('s2', 't1'), session('s3', 't1')],
            activeSessionId: 's1' // the persisted "last focused" pointer
          })
        ],
        activeTaskId: 't1',
        sessionTypes: [],
        settings: initialData().settings,
        version: 1,
        thisWindowId: 'main',
        thisWindowRole: 'main',
        windows: [],
        issues: [],
        initialMark
      }
    }

    it('a FRESH window (no prior mark) marks initialMark’s session, overriding the persisted pointer', () => {
      useStore.getState().hydrate(stateWith({ taskId: 't1', sessionId: 's2' }))
      expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    })

    it('an EXISTING per-window mark wins over initialMark on re-hydrate', () => {
      useStore.getState().hydrate(stateWith(undefined))
      useStore.getState().setActiveSession('t1', 's3')
      // A second hydrate (e.g. SettingsModal) carries an initialMark again — this window
      // already has its own mark (s3) and keeps it; initialMark never overrides it.
      useStore.getState().hydrate(stateWith({ taskId: 't1', sessionId: 's2' }))
      expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
    })

    it('activeTaskId always comes from state, never from initialMark', () => {
      const state = { ...stateWith({ taskId: 't1', sessionId: 's2' }), activeTaskId: 't1' }
      useStore.getState().hydrate(state)
      expect(useStore.getState().activeTaskId).toBe('t1')
      // A crash-reload re-hydrate with a DIFFERENT activeTaskId must win outright, even
      // though initialMark still names t1 — it only ever feeds `pickMark`, scoped to its
      // own task, never the window's current task.
      const other = {
        ...state,
        tasks: [...state.tasks, task('t2', { sessions: [] })],
        activeTaskId: 't2'
      }
      useStore.getState().hydrate(other)
      expect(useStore.getState().activeTaskId).toBe('t2')
    })

    it('initialMark naming a session NOT hosted in this window is ignored', () => {
      const state = stateWith({ taskId: 't1', sessionId: 's2' })
      const t1 = state.tasks[0]
      const sessions = t1.sessions.map((x) => (x.id === 's2' ? { ...x, windowId: 'win-2' } : x))
      useStore.getState().hydrate({ ...state, tasks: [{ ...t1, sessions }] })
      // s2 (named by initialMark) isn't hosted here, so pickMark falls through to the
      // persisted pointer (s1, hosted here).
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    })

    it('initialMark naming a DIFFERENT task than entry is scoped away — ignored for t1', () => {
      const state = stateWith({ taskId: 't-other', sessionId: 's2' })
      useStore.getState().hydrate(state)
      // initialMark doesn't name t1, so t1 falls through to the persisted pointer (s1).
      expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    })
  })

  describe('ready-for-review within a shown group (§9.5, CLAUDE_STATE_PRD "Split panes")', () => {
    it('a visible-but-UNFOCUSED groupmate still raises the review dot', () => {
      // s1 is the group's mark (focused); s2 is its groupmate — rendered on screen in the
      // SAME split, but `isSessionFocused` only ever says true for the ONE marked pane.
      let d = groupedBase() // mark = s1
      d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's2', state: 'working' })
      d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's2', state: 'waiting' })
      expect(d.hasUnseenFinishedTurn.s2).toBe(true)
      expect(isSessionFocused(d, 's2')).toBe(false)
      expect(sessionDisplayState(d.sessions.s2, true, isSessionFocused(d, 's2'))).toBe('review')
    })

    it('it is NOT cleared by markVisibleSessionSeen until that groupmate becomes the mark', () => {
      let d = groupedBase()
      d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's2', state: 'working' })
      d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's2', state: 'waiting' })
      useStore.setState(d)

      // The mark is still s1: clearing "visible session seen" clears nothing for s2 — a
      // visible-but-unmarked groupmate is not what markVisibleSessionSeen looks at.
      expect(useStore.getState().markVisibleSessionSeen()).toBeUndefined()
      expect(useStore.getState().hasUnseenFinishedTurn.s2).toBe(true)

      // Moving the mark onto s2 (a pane click / focus-pane chord) makes it the on-screen
      // session; the settled-render effect then clears and relays it.
      useStore.getState().focusPane('s2')
      expect(useStore.getState().hasUnseenFinishedTurn.s2).toBe(true) // focusPane itself doesn't clear
      expect(useStore.getState().markVisibleSessionSeen()).toBe('s2')
      expect(useStore.getState().hasUnseenFinishedTurn.s2).toBeUndefined()
    })
  })

  describe('state-change toast for a visible-but-unfocused groupmate (§9.5)', () => {
    // Mirrors "ready-for-review within a shown group" above: s2 is rendered on screen,
    // in the SAME split pane as the mark (s1), but `isSessionFocused` only ever says
    // true for the ONE marked pane. The §9.5 toast reducer (sessionStateNotification,
    // store.ts ~937) suppresses SOLELY on `isSessionFocused`, so a groupmate that is
    // visible-but-not-marked must still toast — a regression that widened suppression to
    // "any leaf of the focused group" (not just the mark) would wrongly drop this toast.
    it('still toasts for a visible-but-unmarked groupmate', () => {
      const d = reduceEvent(groupedBase(), {
        type: 'sessionStateNotification',
        sessionId: 's2',
        taskName: 'T',
        sessionName: 'S'
      })
      expect(d.toasts).toHaveLength(1)
    })

    it('still suppresses the toast for the group’s actual mark', () => {
      const d = reduceEvent(groupedBase(), {
        type: 'sessionStateNotification',
        sessionId: 's1',
        taskName: 'T',
        sessionName: 'S'
      })
      expect(d.toasts).toHaveLength(0)
    })
  })
})
