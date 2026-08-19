import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { makeDeps, taskInput } from './test-fakes'
import { TaskLifecycle } from '../../domain/lifecycle'

describe('createTask (§3.5, §6.4)', () => {
  it('drives None → Provisioning → Ready and persists only the Ready task', async () => {
    const { deps, workspace, worktrees, persistence, bus } = makeDeps()

    await createTask(deps, {
      mode: 'new',
      name: 'My Task',
      repoDir: '/repo',
      sourceBranch: 'main',
      newBranch: 'feature/x'
    })

    // One task exists, Ready, with the worktree the provider returned.
    const tasks = workspace.tasks()
    expect(tasks).toHaveLength(1)
    const task = tasks[0]
    expect(task.name).toBe('My Task')
    expect(task.lifecycle).toBe(TaskLifecycle.Ready)
    expect(task.worktree?.path).toBe('/wt/task')
    // The source branch is recorded as the worktree's baseRef (§3.2, §6.4).
    expect(task.worktree?.branch).toBe('feature/x')
    expect(task.worktree?.baseRef).toBe('main')
    // A provisioned worktree is Octopus-managed → removed on delete (§6.4).
    expect(task.worktree?.managed).toBe(true)

    // The provider was invoked with the four create fields (name/repoDir/branches).
    expect(worktrees.createCalls).toHaveLength(1)
    expect(worktrees.createCalls[0]).toMatchObject({
      taskName: 'My Task',
      repoDir: '/repo',
      sourceBranch: 'main',
      newBranch: 'feature/x'
    })

    // Persisted the task + set it active, in one transaction.
    expect(persistence.transactions).toBe(1)
    expect(persistence.upsertedTasks.map((t) => t.id)).toEqual([task.id])
    expect(persistence.activeTaskSet).toEqual([task.id])
    expect(workspace.activeTaskId).toBe(task.id)

    // Emitted: taskCreated (Provisioning) → scriptProgress → taskCreated (Ready) → activeTaskChanged.
    expect(bus.events.map((e) => e.type)).toEqual([
      'taskCreated',
      'scriptProgress',
      'taskCreated',
      'activeTaskChanged'
    ])
    const created = bus.ofType('taskCreated')
    expect(created[0].task.lifecycle).toBe(TaskLifecycle.Provisioning)
    expect(created[1].task.lifecycle).toBe(TaskLifecycle.Ready)
  })

  it('on script failure marks ProvisionFailed, keeps the task unpersisted, and emits scriptError', async () => {
    const { deps, workspace, worktrees, persistence, bus } = makeDeps()
    worktrees.createRejectsWith = new Error('create.sh exited 1')

    await createTask(deps, taskInput('Doomed'))

    const tasks = workspace.tasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].lifecycle).toBe(TaskLifecycle.ProvisionFailed)
    expect(tasks[0].worktree).toBeUndefined()

    // Nothing persisted (only Ready tasks reach the DB), no active task set.
    expect(persistence.transactions).toBe(0)
    expect(persistence.upsertedTasks).toEqual([])
    expect(workspace.activeTaskId).toBeUndefined()

    // Emitted: taskCreated (Provisioning) → scriptProgress → scriptError (no Ready).
    const scriptErrors = bus.ofType('scriptError')
    expect(scriptErrors).toHaveLength(1)
    expect(scriptErrors[0].stderr).toMatch(/create\.sh exited 1/)
    expect(bus.ofType('taskCreated')).toHaveLength(1)
    expect(bus.ofType('activeTaskChanged')).toEqual([])
  })

  it('adopts an existing worktree: stores repoRoot = owning repo (delete-safe) and detected branch', async () => {
    const { deps, workspace, worktrees, persistence, bus } = makeDeps()
    worktrees.adoptedPath = '/home/u/worktrees/wt-x'
    worktrees.adoptedRepoRoot = '/home/u/project'
    worktrees.adoptedBranch = 'feature/adopted'

    await createTask(deps, {
      mode: 'existing',
      name: 'Adopted',
      worktreeDir: '/home/u/worktrees/wt-x'
    })

    // adopt() was called (not create()) with the picked directory.
    expect(worktrees.createCalls).toEqual([])
    expect(worktrees.adoptCalls).toHaveLength(1)
    expect(worktrees.adoptCalls[0]).toMatchObject({
      taskName: 'Adopted',
      worktreeDir: '/home/u/worktrees/wt-x'
    })

    const task = workspace.tasks()[0]
    expect(task.lifecycle).toBe(TaskLifecycle.Ready)
    expect(task.worktree?.path).toBe('/home/u/worktrees/wt-x')
    expect(task.worktree?.branch).toBe('feature/adopted')
    // baseRef is unknown for an adopted worktree.
    expect(task.worktree?.baseRef).toBeUndefined()
    // An adopted directory is NOT Octopus-managed → left on disk on delete (§6.4).
    expect(task.worktree?.managed).toBe(false)
    // repoRoot MUST be the owning repo (not the worktree) so delete is safe (§6.4).
    expect(task.worktree?.provisionedBy.repoRoot).toBe('/home/u/project')
    expect(task.worktree?.provisionedBy.script).toBe('adopt')

    expect(persistence.transactions).toBe(1)
    expect(workspace.activeTaskId).toBe(task.id)
    // Same terminal events as a created task, so the modal closes on success.
    expect(bus.ofType('taskCreated')).toHaveLength(2)
    expect(bus.ofType('activeTaskChanged')).toHaveLength(1)
  })

  it('on adoption failure marks ProvisionFailed and emits scriptError (script: adopt)', async () => {
    const { deps, workspace, persistence, bus, worktrees } = makeDeps()
    worktrees.adoptRejectsWith = new Error('not a git worktree: /tmp/x')

    await createTask(deps, { mode: 'existing', name: 'Doomed', worktreeDir: '/tmp/x' })

    expect(workspace.tasks()[0].lifecycle).toBe(TaskLifecycle.ProvisionFailed)
    expect(persistence.transactions).toBe(0)
    expect(workspace.activeTaskId).toBeUndefined()
    const scriptErrors = bus.ofType('scriptError')
    expect(scriptErrors).toHaveLength(1)
    expect(scriptErrors[0].script).toBe('adopt')
    expect(scriptErrors[0].stderr).toMatch(/not a git worktree/)
  })

  it('creates a "No Repo" task: Ready + repoLess, no worktree, no script (§5.4)', async () => {
    const { deps, workspace, worktrees, persistence, bus } = makeDeps()

    await createTask(deps, { mode: 'none', name: 'Scratch' })

    const task = workspace.tasks()[0]
    expect(task.name).toBe('Scratch')
    expect(task.lifecycle).toBe(TaskLifecycle.Ready)
    expect(task.repoLess).toBe(true)
    expect(task.worktree).toBeUndefined()

    // No worktree provider was touched — nothing is provisioned or adopted.
    expect(worktrees.createCalls).toEqual([])
    expect(worktrees.adoptCalls).toEqual([])

    // Persisted the Ready task + set it active, in one transaction.
    expect(persistence.transactions).toBe(1)
    expect(persistence.upsertedTasks.map((t) => t.id)).toEqual([task.id])
    expect(persistence.activeTaskSet).toEqual([task.id])
    expect(workspace.activeTaskId).toBe(task.id)

    // Only taskCreated (Ready) → activeTaskChanged: no Provisioning announce, no
    // scriptProgress, no scriptError (the modal closes on activeTaskChanged).
    expect(bus.events.map((e) => e.type)).toEqual(['taskCreated', 'activeTaskChanged'])
    expect(bus.ofType('taskCreated')[0].task.lifecycle).toBe(TaskLifecycle.Ready)
    expect(bus.ofType('taskCreated')[0].task.repoLess).toBe(true)
  })

  it('positions a second task after the first', async () => {
    const { deps, workspace } = makeDeps()
    await createTask(deps, taskInput('first'))
    await createTask(deps, taskInput('second'))
    const tasks = workspace.tasks()
    expect(tasks.map((t) => t.position)).toEqual([0, 1])
    expect(tasks.map((t) => t.name)).toEqual(['first', 'second'])
  })
})
