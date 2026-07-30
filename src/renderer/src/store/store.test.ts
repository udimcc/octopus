import { describe, it, expect, beforeEach } from 'vitest'
import {
  reduceEvent,
  initialData,
  useStore,
  sessionIdsInWindow,
  activeSessionInWindow,
  isSessionFocused,
  taskReadyForReview,
  type StoreData
} from './store'
import type { TaskDTO, SessionDTO, WindowedWorkspaceStateDTO } from '../../../shared/dto'

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
    ...over
  }
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

  it('activeSessionChanged re-points the tab in EVERY window; the host window also makes the task active (§5.4)', () => {
    // `this` window is 'main'; the target session s2 is hosted in 'win-2'.
    let d: StoreData = { ...initialData(), windowId: 'main' }
    d = reduceEvent(d, { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    d = reduceEvent(d, {
      type: 'sessionCreated',
      taskId: 't1',
      session: session('s2', 't1', { windowId: 'win-2' })
    })

    // Non-host window: pointer updates, but the active TASK does not change here.
    const notHost = reduceEvent(
      { ...d, activeTaskId: undefined },
      { type: 'activeSessionChanged', taskId: 't1', sessionId: 's2', windowId: 'win-2' }
    )
    expect(notHost.activeSessionByTask.t1).toBe('s2')
    expect(notHost.activeTaskId).toBeUndefined()

    // Host window ('main' hosting a session in it): switch to a main-hosted session
    // makes the task active so its view is on screen when the OS raises the window.
    const host = reduceEvent(
      { ...d, activeTaskId: undefined },
      { type: 'activeSessionChanged', taskId: 't1', sessionId: 's1', windowId: 'main' }
    )
    expect(host.activeSessionByTask.t1).toBe('s1')
    expect(host.activeTaskId).toBe('t1')
  })

  it('activeSessionChanged clears the ready-for-review flag only in the hosting window (§9.5)', () => {
    let d: StoreData = { ...initialData(), windowId: 'main' }
    d = reduceEvent(d, { type: 'taskCreated', task: task('t1') })
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s1', 't1') })
    // A second session becomes the active tab, so s1 is now UNFOCUSED — required for
    // its working → waiting transition to raise the ready-for-review flag (§9.5).
    d = reduceEvent(d, { type: 'sessionCreated', taskId: 't1', session: session('s2', 't1') })
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'working' })
    d = reduceEvent(d, { type: 'sessionStateChanged', sessionId: 's1', state: 'waiting' })
    expect(d.readyForReview.s1).toBe(true)

    // Switching to it in a NON-host window must not clear it (the user hasn't looked).
    const elsewhere = reduceEvent(d, {
      type: 'activeSessionChanged',
      taskId: 't1',
      sessionId: 's1',
      windowId: 'win-9'
    })
    expect(elsewhere.readyForReview.s1).toBe(true)

    // Switching to it in the host window ('main') clears it.
    const here = reduceEvent(d, {
      type: 'activeSessionChanged',
      taskId: 't1',
      sessionId: 's1',
      windowId: 'main'
    })
    expect(here.readyForReview.s1).toBeUndefined()
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
 * Ready-for-review (§9.5): a pure renderer view-model derived from the state stream.
 * Raised on `working → waiting` for an UNFOCUSED session; cleared only on focus.
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
    expect(d.readyForReview.s2).toBe(true)
    expect(taskReadyForReview(d, 't1')).toBe(true)
  })

  it('does NOT raise for the focused session (the user is looking at it)', () => {
    let d = base() // s1 focused
    d = setState(d, 's1', 'working')
    d = setState(d, 's1', 'waiting')
    expect(d.readyForReview.s1).toBeUndefined()
  })

  it('does NOT raise on blocked → waiting (an answered prompt is not new finished work)', () => {
    let d = base()
    d = setState(d, 's2', 'blocked')
    d = setState(d, 's2', 'waiting')
    expect(d.readyForReview.s2).toBeUndefined()
  })

  it('does NOT raise on a straight-to-waiting with no prior working (fresh prompt)', () => {
    let d = base()
    d = setState(d, 's2', 'waiting')
    expect(d.readyForReview.s2).toBeUndefined()
  })

  it('raises for the active tab when its OWN window is blurred', () => {
    let d = { ...base(), windowFocused: false }
    d = setState(d, 's1', 'working') // s1 is the active tab, but window is blurred
    d = setState(d, 's1', 'waiting')
    expect(d.readyForReview.s1).toBe(true)
  })

  it('isSessionFocused reflects active-tab + this-window + window-focus', () => {
    const d = base()
    expect(isSessionFocused(d, 's1')).toBe(true)
    expect(isSessionFocused(d, 's2')).toBe(false)
    expect(isSessionFocused({ ...d, windowFocused: false }, 's1')).toBe(false)
  })

  it('setActiveSession clears the flag on the newly-focused session', () => {
    useStore.setState({ ...base(), readyForReview: { s2: true } })
    useStore.getState().setActiveSession('t1', 's2')
    expect(useStore.getState().readyForReview.s2).toBeUndefined()
  })

  it('regaining window focus clears the visible session flag', () => {
    useStore.setState({ ...base(), windowFocused: false, readyForReview: { s1: true } })
    useStore.getState().setWindowFocused(true)
    expect(useStore.getState().readyForReview.s1).toBeUndefined()
  })

  it('closing a session drops any lingering flag', () => {
    let d: StoreData = { ...base(), readyForReview: { s2: true } }
    d = reduceEvent(d, { type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
    expect(d.readyForReview.s2).toBeUndefined()
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
