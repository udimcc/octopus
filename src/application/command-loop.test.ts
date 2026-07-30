import { describe, it, expect } from 'vitest'
import { CommandLoop } from './command-loop'
import type { AppDependencies } from './dependencies'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  AdoptWorktreeResult
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
  const mkTask = (taskId: string, sessionId: string, position: number): WorkspaceSnapshot['tasks'][number] => ({
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
