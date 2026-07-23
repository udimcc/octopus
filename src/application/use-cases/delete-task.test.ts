import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { deleteTask } from './delete-task'
import { makeDeps, taskInput, type FakeDeps } from './test-fakes'
import { asTaskId } from '../../domain/ids'
import { TaskLifecycle } from '../../domain/lifecycle'

/** Seed one Ready, active task ('task-1') with `sessionCount` running sessions. */
async function seedReadyTask(sessionCount = 0): Promise<FakeDeps & { taskId: ReturnType<typeof asTaskId> }> {
  const fd = makeDeps()
  await createTask(fd.deps, taskInput('T'))
  const taskId = asTaskId('task-1')
  for (let i = 0; i < sessionCount; i++) {
    await openSession(fd.deps, { taskId })
  }
  return { ...fd, taskId }
}

describe('deleteTask dirty gate (§6.6 step 2, §6.4)', () => {
  it('returns needsDirtyConfirm and tears down NOTHING when the worktree is dirty', async () => {
    const fd = await seedReadyTask(1)
    fd.worktrees.dirty = true
    const runtime = fd.sessions.last()!

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result).toEqual({ ok: false, needsDirtyConfirm: true })
    // Task still present and Ready; runtime untouched; nothing removed.
    expect(fd.workspace.task(fd.taskId)?.lifecycle).toBe(TaskLifecycle.Ready)
    expect(runtime.stopped).toBe(false)
    expect(fd.worktrees.removeCalls).toEqual([])
    expect(fd.persistence.deletedTasks).toEqual([])
  })

  it('proceeds when the user confirms the dirty worktree', async () => {
    const fd = await seedReadyTask(1)
    fd.worktrees.dirty = true

    const result = await deleteTask(fd.deps, { taskId: fd.taskId, confirmedDirty: true })

    expect(result).toEqual({ ok: true })
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    expect(fd.worktrees.removeCalls).toHaveLength(1)
  })
})

describe('deleteTask strict teardown order (I3, §6.6)', () => {
  it('stops+disposes runtimes, runs the delete script, removes rows, and clears the active pointer', async () => {
    const fd = await seedReadyTask(2)
    const [rt1, rt2] = fd.sessions.created

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result).toEqual({ ok: true })
    // Every runtime stopped + disposed + dropped from the registry.
    expect(rt1.stopped && rt1.disposed).toBe(true)
    expect(rt2.stopped && rt2.disposed).toBe(true)
    expect(fd.deps.runtimes.all()).toEqual([])

    // Delete ran with the stored path AND the task's OWN repoDir (round-tripped
    // from the create input via provisionedBy.repoRoot, §6.4 — not a global).
    expect(fd.worktrees.removeCalls).toHaveLength(1)
    expect(fd.worktrees.removeCalls[0]).toMatchObject({
      taskName: 'T',
      path: '/wt/task',
      repoDir: '/repo'
    })

    // Row removed in a transaction; task gone; active pointer cleared (it was active).
    expect(fd.persistence.deletedTasks).toEqual([fd.taskId])
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    expect(fd.workspace.activeTaskId).toBeUndefined()

    // Announced taskDeleted (+ activeTaskChanged since it was active).
    expect(fd.bus.ofType('taskDeleted').map((e) => e.taskId)).toEqual([fd.taskId])
    expect(fd.bus.ofType('activeTaskChanged')).toHaveLength(2) // create + delete
  })
})

describe('deleteTask remove-script failure (I4)', () => {
  it('keeps the record as DeleteFailed, emits scriptError, and returns ok:false', async () => {
    const fd = await seedReadyTask(1)
    fd.worktrees.removeRejectsWith = new Error('delete.sh: permission denied')
    const runtime = fd.sessions.last()!

    const result = await deleteTask(fd.deps, { taskId: fd.taskId })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/permission denied/)
    // Runtime WAS torn down (step 3 precedes the failing script), but the record stays.
    expect(runtime.disposed).toBe(true)
    const task = fd.workspace.task(fd.taskId)
    expect(task?.lifecycle).toBe(TaskLifecycle.DeleteFailed)
    // No row deletion happened (we stopped at the failed script).
    expect(fd.persistence.deletedTasks).toEqual([])
    expect(fd.bus.ofType('scriptError')).toHaveLength(1)
  })
})

describe('deleteTask force-forget (I4)', () => {
  it('removes a DeleteFailed task without re-running the delete script when forced', async () => {
    const fd = await seedReadyTask(0)
    // First attempt fails → task is DeleteFailed.
    fd.worktrees.removeRejectsWith = new Error('boom')
    await deleteTask(fd.deps, { taskId: fd.taskId })
    expect(fd.workspace.task(fd.taskId)?.lifecycle).toBe(TaskLifecycle.DeleteFailed)
    const removeCallsBefore = fd.worktrees.removeCalls.length

    // Force-forget: no further script run, record dropped.
    const result = await deleteTask(fd.deps, { taskId: fd.taskId, force: true })
    expect(result).toEqual({ ok: true })
    expect(fd.worktrees.removeCalls.length).toBe(removeCallsBefore) // no new script call
    expect(fd.workspace.task(fd.taskId)).toBeUndefined()
    expect(fd.persistence.deletedTasks).toContain(fd.taskId)
  })

  it('force-forget skips the dirty gate entirely', async () => {
    const fd = await seedReadyTask(0)
    fd.worktrees.dirty = true
    const result = await deleteTask(fd.deps, { taskId: fd.taskId, force: true })
    // No needsDirtyConfirm despite a dirty tree — force bypasses the gate.
    expect(result).toEqual({ ok: true })
  })
})

describe('deleteTask idempotence (I4)', () => {
  it('deleting an already-gone task is a success no-op', async () => {
    const { deps } = makeDeps()
    const result = await deleteTask(deps, { taskId: asTaskId('ghost') })
    expect(result).toEqual({ ok: true })
  })
})
