import { describe, it, expect } from 'vitest'
import { Task } from './task'
import { Session } from './session'
import { WorktreeRef } from './worktree-ref'
import { asTaskId, asSessionId, asTypeId } from './ids'
import { TaskLifecycle, SessionLifecycle } from './lifecycle'
import { TaskState } from './state'
import { worstStatusWins } from './task-state-aggregator'
import { IllegalTransitionError, InvariantViolationError } from './errors'

const T1 = asTaskId('t1')
const TERMINAL = asTypeId('terminal')

function newTask(): Task {
  return Task.create({ id: T1, name: 'task', position: 0, createdAt: 1 })
}

function newSession(id: string, taskId = T1, order = 0): Session {
  return Session.create({
    id: asSessionId(id),
    taskId,
    typeId: TERMINAL,
    title: id,
    config: { kind: 'terminal' },
    order,
    createdAt: 1
  })
}

describe('Task lifecycle (§3.5)', () => {
  it('drives None → Provisioning → Ready with a worktree (I1)', () => {
    const t = newTask()
    expect(t.lifecycle).toBe(TaskLifecycle.None)
    t.markProvisioning()
    const wt = WorktreeRef.create({
      path: '/wt',
      managed: true,
      provisionedBy: { script: 's', args: [], repoRoot: '/r', provisionedAt: 1 }
    })
    t.markReady(wt)
    expect(t.lifecycle).toBe(TaskLifecycle.Ready)
    expect(t.worktree).toBe(wt)
  })

  it('throws on an illegal transition', () => {
    const t = newTask()
    expect(() => t.markReady(undefined as never)).toThrow(IllegalTransitionError)
  })

  it('drives None → Provisioning → Ready with NO worktree for a "No Repo" task (I1\', §5.4)', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReadyNoRepo()
    expect(t.lifecycle).toBe(TaskLifecycle.Ready)
    expect(t.worktree).toBeUndefined()
    expect(t.repoLess).toBe(true)
  })
})

describe('Task sessions (§3.2)', () => {
  it('rejects a session whose taskId does not match (I7)', () => {
    const t = newTask()
    const foreign = newSession('s1', asTaskId('other'))
    expect(() => t.addSession(foreign)).toThrow(InvariantViolationError)
  })

  it('makes the first added session active by default', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(t.activeSessionId).toBe(asSessionId('s1'))
  })

  it('rejects duplicate session ids', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(() => t.addSession(newSession('s1'))).toThrow(InvariantViolationError)
  })

  it('reassigns the active session when the active one is removed (I10)', () => {
    const t = newTask()
    t.addSession(newSession('s1', T1, 0))
    t.addSession(newSession('s2', T1, 1))
    expect(t.activeSessionId).toBe(asSessionId('s1'))
    t.removeSession(asSessionId('s1'))
    expect(t.activeSessionId).toBe(asSessionId('s2'))
  })

  it('clears the active session when the last one is removed', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    t.removeSession(asSessionId('s1'))
    expect(t.activeSessionId).toBeUndefined()
  })

  it('rejects setActiveSession for a session not in the task (I10)', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(() => t.setActiveSession(asSessionId('ghost'))).toThrow(InvariantViolationError)
  })

  it('reorders sessions and renumbers order densely', () => {
    const t = newTask()
    t.addSession(newSession('s1', T1, 0))
    t.addSession(newSession('s2', T1, 1))
    t.addSession(newSession('s3', T1, 2))
    t.reorderSession(asSessionId('s3'), 0)
    expect(t.sessions().map((s) => s.id)).toEqual([
      asSessionId('s3'),
      asSessionId('s1'),
      asSessionId('s2')
    ])
    expect(t.sessions().map((s) => s.order)).toEqual([0, 1, 2])
  })
})

describe('Task derived state (§3.4, I11)', () => {
  it('is Unknown for a task with only live V1 sessions', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(t.deriveState(worstStatusWins)).toBe(TaskState.Unknown)
  })

  it('becomes Blocked when a session has Exited (I12)', () => {
    const t = newTask()
    const s = newSession('s1')
    t.addSession(s)
    s.markStarting()
    s.markRunning()
    s.markExited(2)
    expect(s.lifecycle).toBe(SessionLifecycle.Exited)
    expect(t.deriveState(worstStatusWins)).toBe(TaskState.NeedsInput)
  })
})

describe('Task snapshot round-trip (I15)', () => {
  it('reconstructs an equivalent task from its snapshot', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReady(
      WorktreeRef.create({
        path: '/wt',
        branch: 'b',
        managed: true,
        provisionedBy: { script: 's', args: ['x'], repoRoot: '/r', provisionedAt: 9 }
      })
    )
    t.addSession(newSession('s1', T1, 0))
    t.addSession(newSession('s2', T1, 1))
    const snap = t.toSnapshot(worstStatusWins)
    const restored = Task.fromSnapshot(snap)
    expect(restored.id).toBe(t.id)
    expect(restored.lifecycle).toBe(TaskLifecycle.Ready)
    expect(restored.worktree?.path).toBe('/wt')
    expect(restored.sessions().map((s) => s.id)).toEqual([asSessionId('s1'), asSessionId('s2')])
    expect(restored.activeSessionId).toBe(asSessionId('s1'))
  })

  it('round-trips a "No Repo" task: repoLess Ready with no worktree (§5.4)', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReadyNoRepo()
    t.addSession(newSession('s1', T1, 0))
    const snap = t.toSnapshot(worstStatusWins)
    expect(snap.repoLess).toBe(true)
    expect(snap.worktree).toBeUndefined()
    const restored = Task.fromSnapshot(snap)
    expect(restored.lifecycle).toBe(TaskLifecycle.Ready)
    expect(restored.repoLess).toBe(true)
    expect(restored.worktree).toBeUndefined()
    expect(restored.sessions().map((s) => s.id)).toEqual([asSessionId('s1')])
  })

  it('defaults repoLess to false when a snapshot omits it (pre-feature rows)', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReady(
      WorktreeRef.create({
        path: '/wt',
        managed: true,
        provisionedBy: { script: 's', args: [], repoRoot: '/r', provisionedAt: 1 }
      })
    )
    const snap = t.toSnapshot(worstStatusWins)
    const { repoLess: _omit, ...withoutRepoLess } = snap
    void _omit
    const restored = Task.fromSnapshot(withoutRepoLess)
    expect(restored.repoLess).toBe(false)
  })

  it('drops a dangling active-session pointer on rehydrate (I10)', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    const snap = t.toSnapshot(worstStatusWins)
    const tampered = { ...snap, activeSessionId: asSessionId('ghost') }
    const restored = Task.fromSnapshot(tampered)
    expect(restored.activeSessionId).toBeUndefined()
  })
})
