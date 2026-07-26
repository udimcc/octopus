import { describe, it, expect, beforeEach } from 'vitest'
import { reduceEvent, initialData, useStore, type StoreData } from './store'
import type { TaskDTO, SessionDTO, WorkspaceStateDTO } from '../../../shared/dto'

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
})

describe('useStore hydrate + actions', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  const state: WorkspaceStateDTO = {
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
      defaultSessionTypeId: 'terminal'
    },
    version: 1
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
