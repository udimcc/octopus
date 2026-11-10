import { describe, it, expect } from 'vitest'
import { createTask } from './create-task'
import { createIssue } from './create-issue'
import { bindIssue } from './bind-issue'
import { makeDeps, taskInput } from './test-fakes'
import { TaskLifecycle } from '../../domain/lifecycle'
import { IssueStatus } from '../../domain/issue'
import { asIssueId, asTaskId } from '../../domain/ids'

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

describe('createTask issue binding (Issues §13.3, I19)', () => {
  it('binds the requested issue only once Ready (mode: new), moving Todo → InProgress', async () => {
    const fd = makeDeps()
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    const eventsBefore = fd.bus.events.length
    // m3: capture the issue's binding state at the moment the Provisioning
    // `taskCreated` fires — binding only happens inside the Ready persist
    // transaction (module doc), never at Provisioning.
    let issueTaskIdAtProvisioning: unknown = 'not observed'
    const unsubscribe = fd.bus.subscribe((e) => {
      if (e.type === 'taskCreated' && e.task.lifecycle === TaskLifecycle.Provisioning) {
        issueTaskIdAtProvisioning = fd.workspace.issue(issueId)!.taskId
      }
    })

    await createTask(fd.deps, taskInput('T', { issueId }))
    unsubscribe()

    expect(issueTaskIdAtProvisioning).toBeUndefined()

    const taskId = asTaskId('task-1')
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(taskId)
    expect(issue.status).toBe(IssueStatus.InProgress)
    // issueUpserted published AFTER taskCreated (Ready), among this call's own events.
    const types = fd.bus.events.slice(eventsBefore).map((e) => e.type)
    const createdReadyIdx = types.lastIndexOf('taskCreated')
    const issueUpsertedIdx = types.indexOf('issueUpserted')
    expect(issueUpsertedIdx).toBeGreaterThan(createdReadyIdx)
  })

  it('binds the requested issue only once Ready (mode: none)', async () => {
    const fd = makeDeps()
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    const eventsBefore = fd.bus.events.length

    await createTask(fd.deps, { mode: 'none', name: 'Scratch', issueId })

    const taskId = asTaskId('task-1')
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(taskId)
    expect(issue.status).toBe(IssueStatus.InProgress)
    const newEventTypes = fd.bus.events.slice(eventsBefore).map((e) => e.type)
    expect(newEventTypes.filter((t) => t === 'issueUpserted')).toHaveLength(1)
  })

  it('a PROVISIONING failure leaves the requested issue completely unbound and the task unpersisted', async () => {
    const fd = makeDeps()
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    const eventsBefore = fd.bus.events.length
    fd.worktrees.createRejectsWith = new Error('create.sh exited 1')

    await createTask(fd.deps, taskInput('Doomed', { issueId }))

    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBeUndefined()
    expect(issue.status).toBe(IssueStatus.Todo)
    expect(fd.bus.events.slice(eventsBefore).filter((e) => e.type === 'issueUpserted')).toEqual([])
    expect(fd.persistence.upsertedTasks).toEqual([])
  })

  it('stale-view: issue already bound to a DIFFERENT task — task is created unbound + error toast', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('Other'))
    const otherTaskId = asTaskId('task-1')
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    bindIssue(fd.deps, { issueId, taskId: otherTaskId })

    const res = await createTask(fd.deps, taskInput('New', { issueId }))

    expect(res).toEqual({ ok: true, taskId: asTaskId('task-2') })
    const newTaskId = asTaskId('task-2')
    expect(fd.workspace.task(newTaskId)).toBeDefined()
    // The issue stays bound to the OTHER task, untouched.
    expect(fd.workspace.issue(issueId)!.taskId).toBe(otherTaskId)
    const errors = fd.bus.ofType('error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('Issue was linked to another task; task created without it')
    expect(errors[0].taskId).toBe(newTaskId)
  })

  it('stale-view: issue no longer exists — task is created unbound + error toast', async () => {
    const fd = makeDeps()
    const bogusIssueId = asIssueId('ghost-issue')

    const res = await createTask(fd.deps, taskInput('New', { issueId: bogusIssueId }))

    expect(res).toEqual({ ok: true, taskId: asTaskId('task-1') })
    const taskId = asTaskId('task-1')
    expect(fd.workspace.task(taskId)).toBeDefined()
    const errors = fd.bus.ofType('error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('Issue no longer exists; task created without it')
    expect(errors[0].taskId).toBe(taskId)
  })

  it('a PERSIST failure in the Ready transaction rolls back the task add, the prior active task, and the issue binding', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('First'))
    const firstTaskId = asTaskId('task-1')
    expect(fd.workspace.activeTaskId).toBe(firstTaskId)
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!

    // Throw from upsertIssue (not upsertTask), so `bindRequestedIssue` has already
    // run `Workspace.bindIssue` (taskId set, Todo -> InProgress) by the time the
    // transaction fails — only then does the catch's `restoreIssueBinding` have
    // anything to undo. Throwing at `upsertTask` instead would fail before the
    // bind ever runs, never exercising the rollback.
    fd.persistence.upsertIssue = () => {
      throw new Error('disk full')
    }

    const res = await createTask(fd.deps, taskInput('Second', { issueId }))

    expect(res).toEqual({ ok: false, error: 'disk full' })
    const newTaskId = asTaskId('task-2')
    expect(fd.workspace.task(newTaskId)).toBeUndefined()
    // The prior active task is restored.
    expect(fd.workspace.activeTaskId).toBe(firstTaskId)
    // The issue's prior (unbound, Todo) binding/status is restored. `removeTask`
    // alone only clears the binding (I19) and leaves status at InProgress, so this
    // also exercises `restoreIssueBinding`'s status restore specifically.
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBeUndefined()
    expect(issue.status).toBe(IssueStatus.Todo)
    // taskCreated (Provisioning) was undone, and the failure was announced.
    expect(fd.bus.ofType('taskDeleted').map((e) => e.taskId)).toEqual([newTaskId])
    expect(fd.bus.ofType('error').map((e) => e.taskId)).toEqual([newTaskId])
    // Only createIssue's own issueUpserted was ever published — the failed bind's
    // upsertIssue call threw before `bindRequestedIssue` could publish anything,
    // and `announceBindOutcome` is never reached on this path.
    expect(fd.bus.ofType('issueUpserted')).toHaveLength(1)
  })

  it('MINOR 3: binds the requested issue for mode "existing" (adopted worktree) too', async () => {
    const fd = makeDeps()
    fd.worktrees.adoptedPath = '/home/u/worktrees/wt-x'
    fd.worktrees.adoptedRepoRoot = '/home/u/project'
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!

    await createTask(fd.deps, {
      mode: 'existing',
      name: 'Adopted',
      worktreeDir: '/home/u/worktrees/wt-x',
      issueId
    })

    const taskId = asTaskId('task-1')
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBe(taskId)
    expect(issue.status).toBe(IssueStatus.InProgress)
    // The persisted upsert carries the taskId, same as the SQL-visible binding.
    const upserted = fd.persistence.upsertedIssues.at(-1)!
    expect(upserted.id).toBe(issueId)
    expect(upserted.taskId).toBe(taskId)
  })

  it('a PERSIST failure (provisioning mode, issue-bound variant) emits taskDeleted + error and returns ok:false', async () => {
    const fd = makeDeps()
    const issueId = createIssue(fd.deps, { name: 'Fix', description: '' }).issueId!
    // Same reasoning as above: throw from upsertIssue so the bind actually ran
    // in-memory before the rollback has to undo it.
    fd.persistence.upsertIssue = () => {
      throw new Error('disk full')
    }

    const res = await createTask(fd.deps, taskInput('T', { issueId }))

    expect(res).toEqual({ ok: false, error: 'disk full' })
    const taskId = asTaskId('task-1')
    expect(fd.workspace.task(taskId)).toBeUndefined()
    expect(fd.bus.ofType('taskDeleted').map((e) => e.taskId)).toEqual([taskId])
    expect(fd.bus.ofType('error').map((e) => e.taskId)).toEqual([taskId])
    const issue = fd.workspace.issue(issueId)!
    expect(issue.taskId).toBeUndefined()
    expect(issue.status).toBe(IssueStatus.Todo)
    expect(fd.bus.ofType('issueUpserted')).toHaveLength(1)
  })
})

describe('createTask background (octopus-cli control socket)', () => {
  it('returns the taskId on Ready and does NOT activate the task', async () => {
    const { deps, workspace, persistence, bus } = makeDeps()

    const res = await createTask(deps, taskInput('Bg', { background: true }))

    const task = workspace.tasks()[0]
    expect(res).toEqual({ ok: true, taskId: task.id })
    expect(task.lifecycle).toBe(TaskLifecycle.Ready)
    expect(workspace.activeTaskId).toBeUndefined()
    expect(persistence.activeTaskSet).toEqual([])
    expect(persistence.upsertedTasks.map((t) => t.id)).toEqual([task.id])
    expect(bus.ofType('activeTaskChanged')).toEqual([])
    // Every event the create emits carries the background flag.
    const created = bus.ofType('taskCreated')
    const progress = bus.ofType('scriptProgress')
    expect(created).toHaveLength(2) // provisioning, then ready
    expect(progress).toHaveLength(1)
    for (const e of created) expect(e.background).toBe(true)
    for (const e of progress) expect(e.background).toBe(true)
  })

  it('leaves a previously active task active', async () => {
    const { deps, workspace } = makeDeps()
    await createTask(deps, taskInput('First'))
    const first = workspace.activeTaskId
    expect(first).toBeDefined()

    const res = await createTask(deps, taskInput('Second', { background: true }))

    expect(res.ok).toBe(true)
    expect(workspace.activeTaskId).toBe(first)
  })

  it('a non-background create still activates and has no background flag', async () => {
    const { deps, workspace, bus } = makeDeps()
    await createTask(deps, taskInput('Fg'))
    expect(workspace.activeTaskId).toBe(workspace.tasks()[0].id)
    const created = bus.ofType('taskCreated')
    expect(created).toHaveLength(2)
    for (const e of created) expect(e.background).toBeUndefined()
  })

  it('provisioning failure returns an error, no taskId, and flags scriptError background', async () => {
    const { deps, workspace, worktrees, bus, persistence } = makeDeps()
    worktrees.createRejectsWith = new Error('create.sh exited 1')

    const res = await createTask(deps, taskInput('Doomed', { background: true }))

    expect(res).toEqual({ ok: false, error: 'create.sh exited 1' })
    expect(workspace.tasks()[0].lifecycle).toBe(TaskLifecycle.ProvisionFailed)
    expect(bus.ofType('scriptError').map((e) => e.background)).toEqual([true])
    expect(workspace.activeTaskId).toBeUndefined()
    expect(persistence.activeTaskSet).toEqual([])
    expect(bus.ofType('activeTaskChanged')).toEqual([])
  })

  it('"none" mode background: returns taskId, flags taskCreated, no activation', async () => {
    const { deps, workspace, bus } = makeDeps()
    const res = await createTask(deps, { mode: 'none', name: 'Scratch', background: true })
    expect(res).toEqual({ ok: true, taskId: workspace.tasks()[0].id })
    expect(workspace.activeTaskId).toBeUndefined()
    expect(bus.ofType('taskCreated').map((e) => e.background)).toEqual([true])
    expect(bus.ofType('activeTaskChanged')).toEqual([])
  })
})
