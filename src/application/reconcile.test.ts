import { describe, it, expect } from 'vitest'
import { reconcileOnStartup, type ReconcileProbe } from './reconcile'
import { makeDeps } from './use-cases/test-fakes'
import { asTaskId, asSessionId, asTypeId } from '../domain/ids'
import { SessionLifecycle, TaskLifecycle } from '../domain/lifecycle'
import { SessionState, TaskState } from '../domain/state'
import type { WorkspaceSnapshot } from '../domain/snapshots'

function snapshotWithWorktrees(paths: Record<string, string>): WorkspaceSnapshot {
  const tasks = Object.entries(paths).map(([id, path], i) => ({
    id: asTaskId(id),
    name: id,
    worktree: {
      path,
      managed: true,
      provisionedBy: { script: '/c', args: [id], repoRoot: '/repo', provisionedAt: 1 }
    },
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [
      {
        id: asSessionId(`${id}-s1`),
        taskId: asTaskId(id),
        typeId: asTypeId('terminal'),
        title: 'Terminal 1',
        config: { kind: 'terminal' as const },
        lifecycle: SessionLifecycle.Created,
        state: SessionState.Unknown,
        order: 0,
        createdAt: 1
      }
    ],
    activeSessionId: asSessionId(`${id}-s1`),
    position: i,
    createdAt: 1
  }))
  return { tasks, activeTaskId: tasks[0]?.id }
}

const probeFor = (present: Set<string>): ReconcileProbe => ({
  existsDir: (path) => present.has(path)
})

describe('reconcileOnStartup (§6.3 Restore, I14)', () => {
  it('marks a task whose worktree is missing Stale and emits taskStale — starting no sessions', () => {
    const fd = makeDeps({ snapshot: snapshotWithWorktrees({ t1: '/wt/t1', t2: '/wt/t2' }) })
    // Only t1's worktree still exists on disk.
    reconcileOnStartup(fd.deps, probeFor(new Set(['/wt/t1'])))

    expect(fd.workspace.task(asTaskId('t1'))!.lifecycle).toBe(TaskLifecycle.Ready)
    expect(fd.workspace.task(asTaskId('t2'))!.lifecycle).toBe(TaskLifecycle.Stale)
    expect(fd.bus.ofType('taskStale').map((e) => e.taskId)).toEqual([asTaskId('t2')])
    // Reconciliation never starts runtimes (lazy start happens on first activation).
    expect(fd.sessions.created).toEqual([])
  })

  it('leaves every task Ready when all worktrees are present (no events)', () => {
    const fd = makeDeps({ snapshot: snapshotWithWorktrees({ t1: '/wt/t1', t2: '/wt/t2' }) })
    reconcileOnStartup(fd.deps, probeFor(new Set(['/wt/t1', '/wt/t2'])))

    expect(fd.workspace.tasks().map((t) => t.lifecycle)).toEqual([
      TaskLifecycle.Ready,
      TaskLifecycle.Ready
    ])
    expect(fd.bus.ofType('taskStale')).toEqual([])
  })

  it('is a no-op on an empty workspace', () => {
    const fd = makeDeps()
    expect(() => reconcileOnStartup(fd.deps, probeFor(new Set()))).not.toThrow()
    expect(fd.bus.events).toEqual([])
  })
})
