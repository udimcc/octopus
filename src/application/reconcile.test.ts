import { describe, it, expect } from 'vitest'
import { reconcileOnStartup, reconcileStaleGroups, type ReconcileProbe } from './reconcile'
import { makeDeps } from './use-cases/test-fakes'
import { asTaskId, asSessionId, asTypeId, asGroupId } from '../domain/ids'
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

describe('reconcileStaleGroups (DESIGN §5.7 "loading tolerates bad saved data", review I1)', () => {
  function snapshotWithGroups(): WorkspaceSnapshot {
    const taskId = asTaskId('t1')
    const s1 = asSessionId('t1-s1')
    const s2 = asSessionId('t1-s2')
    const sessionBase = {
      taskId,
      typeId: asTypeId('terminal'),
      config: { kind: 'terminal' as const },
      lifecycle: SessionLifecycle.Created,
      state: SessionState.Unknown,
      createdAt: 1
    }
    return {
      tasks: [
        {
          id: taskId,
          name: 't1',
          worktree: {
            path: '/wt/t1',
            managed: true,
            provisionedBy: { script: '/c', args: ['t1'], repoRoot: '/repo', provisionedAt: 1 }
          },
          lifecycle: TaskLifecycle.Ready,
          state: TaskState.Unknown,
          sessions: [
            { ...sessionBase, id: s1, title: 'Terminal 1', order: 0 },
            { ...sessionBase, id: s2, title: 'Terminal 2', order: 1 }
          ],
          activeSessionId: s1,
          position: 0,
          createdAt: 1,
          groups: [
            // Valid: both leaves exist, same window, contiguous — survives hydrate.
            {
              id: asGroupId('g-valid'),
              tree: {
                kind: 'split' as const,
                dir: 'row' as const,
                ratio: 0.5,
                a: { kind: 'leaf' as const, sessionId: s1 },
                b: { kind: 'leaf' as const, sessionId: s2 }
              },
              colorIndex: 0
            },
            // Invalid: references a session id that doesn't exist — rejected by
            // `Task.fromSnapshot`/`restoreGroups` (unknown leaf), never reaching
            // the live task's `groups()`.
            {
              id: asGroupId('g-stale'),
              tree: { kind: 'leaf' as const, sessionId: asSessionId('ghost') },
              colorIndex: 1
            }
          ]
        }
      ],
      activeTaskId: taskId
    }
  }

  it('deletes a group row that hydrate rejected, leaving a surviving one alone', () => {
    const fd = makeDeps({ snapshot: snapshotWithGroups() })
    // The fake persistence doesn't auto-seed its `groups` map from the raw
    // snapshot (it only mirrors writes); seed it here to model the on-disk rows
    // the sweep must diff against.
    fd.persistence.groups.set(asGroupId('g-valid'), {
      taskId: asTaskId('t1'),
      group: {
        id: asGroupId('g-valid'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: asSessionId('t1-s1') },
          b: { kind: 'leaf', sessionId: asSessionId('t1-s2') }
        },
        colorIndex: 0
      }
    })
    fd.persistence.groups.set(asGroupId('g-stale'), {
      taskId: asTaskId('t1'),
      group: {
        id: asGroupId('g-stale'),
        tree: { kind: 'leaf', sessionId: asSessionId('ghost') },
        colorIndex: 1
      }
    })

    const transactionsBefore = fd.persistence.transactions

    reconcileStaleGroups(fd.deps, fd.persistence.load())

    expect(fd.persistence.groups.has(asGroupId('g-stale'))).toBe(false)
    expect(fd.persistence.groups.has(asGroupId('g-valid'))).toBe(true)
    // The delete(s) run inside a real transaction (review U13), not a bare
    // function call that bypasses `deps.persistence.transaction`.
    expect(fd.persistence.transactions).toBe(transactionsBefore + 1)
  })

  it('is a no-op when every saved group survived hydrate (no stale rows, no transaction) (review Finding 14)', () => {
    // Seed a snapshot with ONE real group whose both leaves exist (unlike the
    // prior version of this test, which seeded no groups at all — vacuously
    // "surviving" because there was nothing to survive or drop). This group
    // must actually come back out of `task.groups()` after hydrate for the
    // test to mean anything.
    const base = snapshotWithGroups()
    const raw: WorkspaceSnapshot = {
      ...base,
      tasks: [
        {
          ...base.tasks[0]!,
          groups: base.tasks[0]!.groups!.filter((g) => g.id === asGroupId('g-valid'))
        }
      ]
    }
    const fd = makeDeps({ snapshot: raw })
    expect(
      fd.workspace
        .task(asTaskId('t1'))!
        .groups()
        .map((g) => g.id)
    ).toEqual([asGroupId('g-valid')])
    // Seed the matching on-disk row, same as the sibling "deletes a stale
    // group" test does, so the sweep has something real to diff against.
    fd.persistence.groups.set(asGroupId('g-valid'), {
      taskId: asTaskId('t1'),
      group: {
        id: asGroupId('g-valid'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: asSessionId('t1-s1') },
          b: { kind: 'leaf', sessionId: asSessionId('t1-s2') }
        },
        colorIndex: 0
      }
    })
    const transactionsBefore = fd.persistence.transactions

    expect(() => reconcileStaleGroups(fd.deps, fd.persistence.load())).not.toThrow()

    expect(fd.persistence.groups.has(asGroupId('g-valid'))).toBe(true)
    expect(fd.persistence.transactions).toBe(transactionsBefore)
  })

  it('is a no-op on an empty workspace', () => {
    const fd = makeDeps()
    expect(() => reconcileStaleGroups(fd.deps, fd.persistence.load())).not.toThrow()
  })
})
