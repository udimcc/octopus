import { describe, it, expect } from 'vitest'
import { Workspace } from './workspace'
import { Task } from './task'
import { asTaskId } from './ids'
import { InvariantViolationError } from './errors'
import { worstStatusWins } from './task-state-aggregator'

const config = { defaultSessionTypeId: 'terminal' }

function task(id: string, position: number): Task {
  return Task.create({ id: asTaskId(id), name: id, position, createdAt: 1 })
}

describe('Workspace (§3.2, I6/I9)', () => {
  it('adds tasks and rejects duplicate ids (I6)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    expect(() => ws.addTask(task('t1', 1))).toThrow(InvariantViolationError)
  })

  it('keeps at most one active task and validates the pointer (I9)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.setActiveTask(asTaskId('t2'))
    expect(ws.activeTaskId).toBe(asTaskId('t2'))
    expect(() => ws.setActiveTask(asTaskId('ghost'))).toThrow(InvariantViolationError)
  })

  it('clears the active pointer when the active task is removed (I9)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.setActiveTask(asTaskId('t1'))
    ws.removeTask(asTaskId('t1'))
    expect(ws.activeTaskId).toBeUndefined()
  })

  it('reorders tasks and renumbers position densely', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.addTask(task('t3', 2))
    ws.reorderTask(asTaskId('t3'), 0)
    expect(ws.tasks().map((t) => t.id)).toEqual([asTaskId('t3'), asTaskId('t1'), asTaskId('t2')])
    expect(ws.tasks().map((t) => t.position)).toEqual([0, 1, 2])
  })

  it('hydrates from a snapshot, restoring order and a valid active pointer (I15)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.setActiveTask(asTaskId('t1'))
    const snap = ws.toSnapshot(worstStatusWins)
    const restored = Workspace.hydrate(snap, config)
    expect(restored.tasks().map((t) => t.id)).toEqual([asTaskId('t1'), asTaskId('t2')])
    expect(restored.activeTaskId).toBe(asTaskId('t1'))
  })

  it('drops a dangling active-task pointer on hydrate (I9)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    const snap = ws.toSnapshot(worstStatusWins)
    const tampered = { ...snap, activeTaskId: asTaskId('ghost') }
    const restored = Workspace.hydrate(tampered, config)
    expect(restored.activeTaskId).toBeUndefined()
  })

  it('merges config patches without dropping other keys', () => {
    const ws = Workspace.create(config)
    ws.updateConfig({ defaultSessionTypeId: 'jenkins' })
    expect(ws.config.defaultSessionTypeId).toBe('jenkins')
  })
})
