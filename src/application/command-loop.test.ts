import { describe, it, expect } from 'vitest'
import { CommandLoop } from './command-loop'
import type { AppDependencies } from './dependencies'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  AdoptWorktreeResult,
  InspectRepoResult,
  RepoWorktree
} from '../ports/worktree-provider'
import { makeDeps, taskInput } from './use-cases/test-fakes'
import { asTaskId, asSessionId, asTypeId } from '../domain/ids'
import { SessionLifecycle, TaskLifecycle } from '../domain/lifecycle'
import { SessionState, TaskState } from '../domain/state'
import type { WorkspaceSnapshot } from '../domain/snapshots'

/** Yield the macrotask queue so queued microtask chains settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * A worktree provider whose `create` blocks on a per-call gate, so a test can
 * observe exactly when each command reaches (and passes) its awaited I/O — the
 * lever for asserting the loop serializes commands rather than interleaving them.
 */
class GatedWorktreeProvider implements WorktreeProvider {
  readonly log: string[] = []
  private readonly gates: Array<() => void> = []

  async create(
    req: CreateWorktreeRequest,
    onProgress?: (line: string) => void
  ): Promise<CreateWorktreeResult> {
    onProgress?.('provisioning')
    this.log.push(`start:${req.taskName}`)
    await new Promise<void>((resolve) => {
      this.gates.push(() => {
        this.log.push(`resume:${req.taskName}`)
        resolve()
      })
    })
    return { path: `/wt/${req.taskName}`, script: '/c', args: [req.taskName] }
  }
  async adopt(): Promise<AdoptWorktreeResult> {
    return { path: '/wt/adopted', repoRoot: '/repo', branch: 'main' }
  }
  async remove(): Promise<void> {}
  async isDirty(): Promise<boolean> {
    return false
  }
  async inspectRepo(dir: string): Promise<InspectRepoResult> {
    return { root: dir }
  }
  async listWorktrees(): Promise<readonly RepoWorktree[]> {
    return []
  }

  /** Release the i-th started create (0-based). */
  resume(i: number): void {
    this.gates[i]?.()
  }
}

function loopWith(worktrees: WorktreeProvider): CommandLoop {
  const { deps } = makeDeps()
  const wired: AppDependencies = { ...deps, worktrees }
  return new CommandLoop(wired)
}

describe('CommandLoop single-writer serialization (§6.6)', () => {
  it('runs commands one at a time in FIFO order — the second waits for the first', async () => {
    const wt = new GatedWorktreeProvider()
    const loop = loopWith(wt)

    const p1 = loop.dispatch({ kind: 'createTask', input: taskInput('a') })
    const p2 = loop.dispatch({ kind: 'createTask', input: taskInput('b') })

    // The loop must have started ONLY the first command; the second is queued
    // behind it and has not touched the (slow) provider yet.
    await tick()
    expect(wt.log).toEqual(['start:a'])

    // Release the first; once it settles, the second begins — never before.
    wt.resume(0)
    await p1
    await tick()
    expect(wt.log).toEqual(['start:a', 'resume:a', 'start:b'])

    wt.resume(1)
    await p2
    expect(wt.log).toEqual(['start:a', 'resume:a', 'start:b', 'resume:b'])
  })
})

describe('CommandLoop error translation (§7)', () => {
  it('turns a domain error into { ok: false, error } and never rejects', async () => {
    const { deps } = makeDeps()
    const loop = new CommandLoop(deps)

    const result = await loop.dispatch({
      kind: 'switchTask',
      input: { taskId: asTaskId('does-not-exist') }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('keeps the chain alive: a command after a failed one still runs and succeeds', async () => {
    const { deps, workspace } = makeDeps()
    const loop = new CommandLoop(deps)

    const bad = await loop.dispatch({
      kind: 'switchTask',
      input: { taskId: asTaskId('nope') }
    })
    expect(bad.ok).toBe(false)

    // The FIFO chain survived the rejection; a subsequent command runs normally.
    const ok = await loop.dispatch({ kind: 'createTask', input: taskInput('after-error') })
    expect(ok.ok).toBe(true)
    expect(workspace.tasks().map((t) => t.name)).toEqual(['after-error'])
  })

  it('treats focusSession for an unknown session as ok (fire-and-forget, raced a close)', async () => {
    const { deps } = makeDeps()
    const loop = new CommandLoop(deps)

    const result = await loop.dispatch({
      kind: 'focusSession',
      input: { sessionId: asSessionId('ghost') }
    })
    expect(result).toEqual({ ok: true })
  })

  it('reports success for a synchronous command', async () => {
    const { deps } = makeDeps()
    const loop = new CommandLoop(deps)

    // Create then rename — both resolve ok:true, in order.
    const created = await loop.dispatch({ kind: 'createTask', input: taskInput('orig') })
    expect(created.ok).toBe(true)
    const renamed = await loop.dispatch({
      kind: 'renameTask',
      input: { taskId: asTaskId('task-1'), name: 'renamed' }
    })
    expect(renamed.ok).toBe(true)
  })
})

/** Two restored Ready tasks, each with one fresh `Created` session (boot state). */
function twoTaskSnapshot(): WorkspaceSnapshot {
  const mkTask = (
    taskId: string,
    sessionId: string,
    position: number
  ): WorkspaceSnapshot['tasks'][number] => ({
    id: asTaskId(taskId),
    name: taskId,
    worktree: {
      path: `/wt/${taskId}`,
      managed: true,
      provisionedBy: { script: 'git', args: [taskId], repoRoot: '/repo', provisionedAt: 1 }
    },
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [
      {
        id: asSessionId(sessionId),
        taskId: asTaskId(taskId),
        typeId: asTypeId('terminal'),
        title: 'Terminal 1',
        config: { kind: 'terminal' as const },
        lifecycle: SessionLifecycle.Created,
        state: SessionState.Unknown,
        order: 0,
        createdAt: 1
      }
    ],
    activeSessionId: asSessionId(sessionId),
    position,
    createdAt: 1
  })
  return {
    tasks: [mkTask('task-1', 'session-1', 0), mkTask('task-2', 'session-2', 1)],
    activeTaskId: asTaskId('task-1')
  }
}

describe('startTaskSessions command (Bug: status only shows on focus — §6.2, §9.6)', () => {
  it('starts a task’s restored sessions WITHOUT moving the active pointer', async () => {
    const { deps, workspace, bus } = makeDeps({ snapshot: twoTaskSnapshot() })
    const loop = new CommandLoop(deps)

    // Boot re-attach of the NON-active task-2 (task-1 is active).
    const res = await loop.dispatch({
      kind: 'startTaskSessions',
      input: { taskId: asTaskId('task-2') }
    })
    expect(res.ok).toBe(true)

    // task-2's session started (runtime → Running), so its state evaluator is now
    // subscribed and will flush state without the user ever focusing the task.
    expect(workspace.task(asTaskId('task-2'))!.session(asSessionId('session-2'))!.lifecycle).toBe(
      SessionLifecycle.Running
    )
    // The active pointer did NOT move (unlike switchTask) — no activeTaskChanged.
    expect(workspace.activeTaskId).toBe(asTaskId('task-1'))
    expect(bus.ofType('activeTaskChanged')).toEqual([])
  })
})

describe('project commands dispatch (§5.4, §6.3)', () => {
  it('addProject resolves via inspectRepo, saves, and returns { ok: true, project }', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)
    fd.worktrees.inspectResults.set('/picked', { root: '/picked', defaultBranch: 'main' })

    const res = await loop.dispatch({ kind: 'addProject', input: { dir: '/picked' } })

    expect(res).toEqual({ ok: true, project: { path: '/picked', defaultBranch: 'main' } })
    expect(fd.settings.load().projects).toEqual([{ path: '/picked', defaultBranch: 'main' }])
  })

  it('removeProject returns the use case’s own CommandResult (blocked by a matching task)', async () => {
    const fd = makeDeps({ snapshot: twoTaskSnapshot() })
    const loop = new CommandLoop(fd.deps)
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = await loop.dispatch({ kind: 'removeProject', input: { path: '/repo' } })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/2 tasks; delete them first/)
  })

  it('removeProject succeeds and persists the filtered list when no task matches', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = await loop.dispatch({ kind: 'removeProject', input: { path: '/repo' } })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([])
  })

  it('setProjectDefaultBranch dispatches and persists the new branch', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = await loop.dispatch({
      kind: 'setProjectDefaultBranch',
      input: { path: '/repo', defaultBranch: 'develop' }
    })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo', defaultBranch: 'develop' }])
  })

  it('seedProjects dispatches and resolves ok even when there is nothing to seed', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)

    const res = await loop.dispatch({ kind: 'seedProjects', input: {} })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toBeUndefined()
  })

  it('addProject: an inspectRepo rejection (non-domain error) resolves { ok: false }, never rejects', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)
    fd.worktrees.inspectRejects.add('/nope')

    const res = await loop.dispatch({ kind: 'addProject', input: { dir: '/nope' } })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not a git repository/)
    expect(fd.settings.load().projects).toBeUndefined()
    expect(fd.settings.saveCalls).toEqual([])
  })

  it('a seedProjects dispatch fully completes before a subsequently dispatched addProject starts (single-writer FIFO)', async () => {
    const fd = makeDeps({ snapshot: twoTaskSnapshot() })
    const loop = new CommandLoop(fd.deps)
    const taskRepoRoot = fd.deps.workspace.tasks()[0].worktree?.provisionedBy.repoRoot
    if (taskRepoRoot) {
      fd.worktrees.inspectResults.set(taskRepoRoot, { root: taskRepoRoot })
    }
    const release = fd.worktrees.pauseInspect()

    const seedPromise = loop.dispatch({ kind: 'seedProjects', input: {} })
    const addPromise = loop.dispatch({ kind: 'addProject', input: { dir: '/picked' } })

    // Let any synchronous/microtask work from both dispatches settle. addProject's
    // inspectRepo('/picked') must NOT have run yet: it is queued behind seedProjects,
    // which is itself still blocked on the gated inspectRepo(taskRepoRoot). If
    // command-loop.ts ever stopped awaiting a dispatch before chaining the next one,
    // this would already include '/picked'.
    await tick()
    expect(fd.worktrees.inspectCalls).not.toContain('/picked')

    release()
    await Promise.all([seedPromise, addPromise])

    const paths = (fd.settings.load().projects ?? []).map((p) => p.path)
    expect(paths).toContain('/picked')
    if (taskRepoRoot) {
      expect(paths).toContain(taskRepoRoot)
    }
  })
})

describe('issue commands dispatch (Issues §13.3, I19)', () => {
  it('createIssue routes to the use case and returns its CommandResult', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)

    const res = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Fix the thing', description: '' }
    })

    expect(res.ok).toBe(true)
    expect(res.issueId).toBeDefined()
    expect(fd.workspace.issue(res.issueId!)).toBeDefined()
  })

  it('bindIssue routes to the use case and returns its CommandResult', async () => {
    const fd = makeDeps({ snapshot: twoTaskSnapshot() })
    const loop = new CommandLoop(fd.deps)
    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Fix', description: '' }
    })

    const res = await loop.dispatch({
      kind: 'bindIssue',
      input: { issueId: created.issueId!, taskId: asTaskId('task-1') }
    })

    expect(res).toEqual({ ok: true })
    expect(fd.workspace.issue(created.issueId!)!.taskId).toBe(asTaskId('task-1'))
  })

  it('a domain error from createIssue (empty name) is caught and becomes { ok: false, error } rather than throwing', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)

    const res = await loop.dispatch({
      kind: 'createIssue',
      input: { name: '   ', description: '' }
    })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/must not be empty/)
  })

  it('m11: updateIssue routes to the use case and returns its CommandResult', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)
    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Fix', description: '' }
    })

    const res = await loop.dispatch({
      kind: 'updateIssue',
      input: { issueId: created.issueId!, name: 'Renamed' }
    })

    expect(res).toEqual({ ok: true })
    expect(fd.workspace.issue(created.issueId!)!.name).toBe('Renamed')
  })

  it('m11: deleteIssue routes to the use case and returns its CommandResult', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)
    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Fix', description: '' }
    })

    const res = await loop.dispatch({ kind: 'deleteIssue', input: { issueId: created.issueId! } })

    expect(res).toEqual({ ok: true })
    expect(fd.workspace.issue(created.issueId!)).toBeUndefined()
  })

  it('m11: unbindIssue routes to the use case and returns its CommandResult', async () => {
    const fd = makeDeps({ snapshot: twoTaskSnapshot() })
    const loop = new CommandLoop(fd.deps)
    const created = await loop.dispatch({
      kind: 'createIssue',
      input: { name: 'Fix', description: '' }
    })
    await loop.dispatch({
      kind: 'bindIssue',
      input: { issueId: created.issueId!, taskId: asTaskId('task-1') }
    })

    const res = await loop.dispatch({ kind: 'unbindIssue', input: { issueId: created.issueId! } })

    expect(res).toEqual({ ok: true })
    expect(fd.workspace.issue(created.issueId!)!.taskId).toBeUndefined()
  })
})

describe('createTask dispatch failure propagation (m11)', () => {
  it('a persist failure in createTask surfaces as { ok: false, error } through the loop, never rejecting', async () => {
    const fd = makeDeps()
    const loop = new CommandLoop(fd.deps)
    fd.persistence.upsertTask = () => {
      throw new Error('disk full')
    }

    const res = await loop.dispatch({ kind: 'createTask', input: { mode: 'none', name: 'x' } })

    expect(res).toEqual({ ok: false, error: 'disk full' })
  })
})
