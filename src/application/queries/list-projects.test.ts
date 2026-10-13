import { describe, it, expect } from 'vitest'
import { listProjects, taskMatchesProject } from './list-projects'
import { createTask } from '../use-cases/create-task'
import { makeDeps, taskInput } from '../use-cases/test-fakes'
import { asTaskId } from '../../domain/ids'
import { TaskLifecycle } from '../../domain/lifecycle'
import { TaskState } from '../../domain/state'
import type { WorkspaceSnapshot } from '../../domain/snapshots'

describe('listProjects (§5.4, §6.3)', () => {
  it('lists configured projects with a live taskCount per matching task', async () => {
    const fd = makeDeps()
    fd.settings.save({
      projects: [{ path: '/repo-a' }, { path: '/repo-b', defaultBranch: 'main' }]
    })
    await createTask(fd.deps, taskInput('a1', { repoDir: '/repo-a' }))
    await createTask(fd.deps, taskInput('a2', { repoDir: '/repo-a' }))
    await createTask(fd.deps, taskInput('b1', { repoDir: '/repo-b' }))

    const items = listProjects(fd.deps)

    expect(items).toEqual([
      { path: '/repo-a', defaultBranch: undefined, taskCount: 2 },
      { path: '/repo-b', defaultBranch: 'main', taskCount: 1 }
    ])
  })

  it('counts zero tasks for a project nobody uses', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/unused' }] })

    const items = listProjects(fd.deps)

    expect(items).toEqual([{ path: '/unused', defaultBranch: undefined, taskCount: 0 }])
  })

  it('excludes repo-less tasks from every project count', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    await createTask(fd.deps, { mode: 'none', name: 'no-repo-task' })

    const items = listProjects(fd.deps)

    expect(items).toEqual([{ path: '/repo', defaultBranch: undefined, taskCount: 0 }])
  })

  it('matches canonically — a trailing-slash project path still counts a task without one', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo/' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    const items = listProjects(fd.deps)

    expect(items[0].taskCount).toBe(1)
  })

  it('returns [] when no projects are configured', () => {
    const fd = makeDeps()
    expect(listProjects(fd.deps)).toEqual([])
  })
})

/**
 * A task that is `repoLess` but ALSO carries a `worktree` whose `repoRoot`
 * matches `repoRoot` — an inconsistent shape the normal `createTask`/`markRepoLess`
 * flow never produces (DESIGN: `Ready ⇒ (has worktree) XOR repoLess`), but which
 * `Task.fromSnapshot` does not reject (the invariant isn't re-validated on
 * restore). Used to isolate the `repoLess` branch in `taskMatchesProject` from
 * the `repoRoot === ''` branch below it — with a REAL repo-less task (no
 * worktree at all) the two branches are indistinguishable, since repoRoot
 * always ends up `''` either way.
 */
function repoLessTaskWithMatchingWorktreeSnapshot(repoRoot: string): WorkspaceSnapshot {
  return {
    tasks: [
      {
        id: asTaskId('t1'),
        name: 'inconsistent',
        createdAt: 1,
        worktree: {
          path: '/wt/t1',
          managed: true,
          provisionedBy: { script: 'git', args: [], repoRoot, provisionedAt: 1 }
        },
        repoLess: true,
        lifecycle: TaskLifecycle.Ready,
        state: TaskState.Unknown,
        sessions: [],
        position: 0
      }
    ]
  }
}

describe('taskMatchesProject (§5.4)', () => {
  it('is false for a real repo-less task (mode: none, no worktree at all)', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, { mode: 'none', name: 'no-repo-task' })
    const [task] = fd.workspace.tasks()
    expect(taskMatchesProject(task, '')).toBe(false)
  })

  it('is false for a repoLess task even when its worktree.repoRoot would otherwise match (isolates the repoLess check from the empty-repoRoot check)', () => {
    const fd = makeDeps({ snapshot: repoLessTaskWithMatchingWorktreeSnapshot('/repo') })
    const [task] = fd.workspace.tasks()
    expect(task.repoLess).toBe(true)
    expect(task.worktree?.provisionedBy.repoRoot).toBe('/repo')

    expect(taskMatchesProject(task, '/repo')).toBe(false)
  })

  it('is false when both the task repoRoot and the project path are empty (no spurious match)', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('a', { repoDir: '' }))
    const [task] = fd.workspace.tasks()
    expect(taskMatchesProject(task, '')).toBe(false)
  })
})
