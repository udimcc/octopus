import { describe, it, expect } from 'vitest'
import { busySessions, isBusy } from './busy-sessions'
import { Workspace } from '../../domain/workspace'
import { Task } from '../../domain/task'
import { Session } from '../../domain/session'
import { asTaskId, asSessionId, asTypeId, type TaskId } from '../../domain/ids'
import { SessionState } from '../../domain/state'

const TERMINAL = asTypeId('terminal')

function makeWorkspace(): Workspace {
  return Workspace.create({ defaultSessionTypeId: 'terminal' })
}

function addTask(ws: Workspace, id: string): Task {
  const task = Task.create({
    id: asTaskId(id),
    name: id,
    position: ws.tasks().length,
    createdAt: 1
  })
  ws.addTask(task)
  return task
}

/** Add a Running session in the given evaluated state to `task`. */
function addRunning(
  task: Task,
  taskId: string,
  id: string,
  state: SessionState,
  order = 0
): Session {
  const s = Session.create({
    id: asSessionId(id),
    taskId: asTaskId(taskId) as TaskId,
    typeId: TERMINAL,
    title: id,
    config: { kind: 'terminal' },
    order,
    createdAt: 1
  })
  s.markStarting()
  s.markRunning()
  s.setState(state)
  task.addSession(s)
  return s
}

describe('busySessions (DESIGN §6.6, I13)', () => {
  it('is empty for an empty workspace', () => {
    const summary = busySessions(makeWorkspace())
    expect(summary).toEqual({ working: 0, blocked: 0, tasks: 0 })
    expect(isBusy(summary)).toBe(false)
  })

  it('counts Working and Blocked live sessions and the tasks that own them', () => {
    const ws = makeWorkspace()
    const t1 = addTask(ws, 't1')
    addRunning(t1, 't1', 's1', SessionState.Working, 0)
    addRunning(t1, 't1', 's2', SessionState.NeedsInput, 1)
    const t2 = addTask(ws, 't2')
    addRunning(t2, 't2', 's3', SessionState.Working, 0)

    const summary = busySessions(ws)
    expect(summary).toEqual({ working: 2, blocked: 1, tasks: 2 })
    expect(isBusy(summary)).toBe(true)
  })

  it('ignores Idle (Waiting) and Unknown sessions', () => {
    const ws = makeWorkspace()
    const t1 = addTask(ws, 't1')
    addRunning(t1, 't1', 's1', SessionState.Idle, 0)
    addRunning(t1, 't1', 's2', SessionState.Unknown, 1)

    const summary = busySessions(ws)
    expect(isBusy(summary)).toBe(false)
    expect(summary.tasks).toBe(0)
  })

  it('ignores a dead (Exited) session even though I12 aggregates it as Blocked', () => {
    const ws = makeWorkspace()
    const t1 = addTask(ws, 't1')
    const s = addRunning(t1, 't1', 's1', SessionState.Working, 0)
    s.markExited(2)

    const summary = busySessions(ws)
    expect(summary).toEqual({ working: 0, blocked: 0, tasks: 0 })
    expect(isBusy(summary)).toBe(false)
  })
})
