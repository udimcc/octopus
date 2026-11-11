import { describe, it, expect } from 'vitest'
import { switchTask } from './switch-task'
import { createTask } from './create-task'
import { makeDeps, taskInput } from './test-fakes'
import { asTaskId, asSessionId, asTypeId } from '../../domain/ids'
import { SessionLifecycle, TaskLifecycle } from '../../domain/lifecycle'
import { SessionState, TaskState } from '../../domain/state'
import type { WorkspaceSnapshot } from '../../domain/snapshots'
import { InvariantViolationError } from '../../domain/errors'

/** A restored snapshot: two Ready tasks, each with one fresh `Created` session. */
function restoredSnapshot(): WorkspaceSnapshot {
  const mkSession = (taskId: string, id: string) => ({
    id: asSessionId(id),
    taskId: asTaskId(taskId),
    typeId: asTypeId('terminal'),
    title: 'Terminal 1',
    config: { kind: 'terminal' as const, cwdOverride: `/wt/${taskId}` },
    lifecycle: SessionLifecycle.Created, // hydrate always reloads as Created (I13)
    state: SessionState.Unknown,
    order: 0,
    createdAt: 1
  })
  const mkTask = (id: string, position: number) => ({
    id: asTaskId(id),
    name: id,
    worktree: {
      path: `/wt/${id}`,
      managed: true,
      provisionedBy: { script: '/c', args: [id], repoRoot: '/repo', provisionedAt: 1 }
    },
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [mkSession(id, `${id}-s1`)],
    activeSessionId: asSessionId(`${id}-s1`),
    position,
    createdAt: 1
  })
  return { tasks: [mkTask('t1', 0), mkTask('t2', 1)], activeTaskId: asTaskId('t1') }
}

describe('switchTask (§3.3, §5.3, §6.3, I9)', () => {
  it('moves the active pointer, persists it, and emits activeTaskChanged', async () => {
    const fd = makeDeps({ snapshot: restoredSnapshot() })

    await switchTask(fd.deps, { taskId: asTaskId('t2') })

    expect(fd.workspace.activeTaskId).toBe(asTaskId('t2'))
    expect(fd.persistence.activeTaskSet).toEqual([asTaskId('t2')])
    expect(fd.bus.ofType('activeTaskChanged').map((e) => e.taskId)).toEqual([asTaskId('t2')])
  })

  it('lazily starts the restored (Created) sessions of the target task only', async () => {
    const fd = makeDeps({ snapshot: restoredSnapshot() })

    await switchTask(fd.deps, { taskId: asTaskId('t2') })

    // t2's session is now Running (its PTY started); t1's remains Created (untouched).
    const t2s = fd.workspace.task(asTaskId('t2'))!.sessions()[0]
    const t1s = fd.workspace.task(asTaskId('t1'))!.sessions()[0]
    expect(t2s.lifecycle).toBe(SessionLifecycle.Running)
    expect(t1s.lifecycle).toBe(SessionLifecycle.Created)

    // Exactly one runtime started, at t2's worktree cwd.
    expect(fd.sessions.created).toHaveLength(1)
    expect(fd.sessions.last()!.ctx.worktreePath).toBe('/wt/t2')
    // Re-announced as an upsert so the store flips created → running.
    expect(fd.bus.ofType('sessionCreated').map((e) => e.session.id)).toEqual([t2s.id])
  })

  it('is idempotent: switching to the already-active task does not move the pointer or re-emit, and is a no-op on already-Running sessions', async () => {
    const fd = makeDeps({ snapshot: restoredSnapshot() })

    // First activation of t1 starts its session.
    await switchTask(fd.deps, { taskId: asTaskId('t1') })
    expect(fd.sessions.created).toHaveLength(1)
    // No pointer move/event since t1 was already active.
    expect(fd.persistence.activeTaskSet).toEqual([])
    expect(fd.bus.ofType('activeTaskChanged')).toEqual([])

    // Second activation: session already Running → not restarted.
    await switchTask(fd.deps, { taskId: asTaskId('t1') })
    expect(fd.sessions.created).toHaveLength(1)
  })

  it('starting a freshly created task via createTask leaves nothing to lazily start on switch', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('fresh'))
    await switchTask(fd.deps, { taskId: asTaskId('task-1') })
    // No sessions defined → no runtimes started.
    expect(fd.sessions.created).toEqual([])
  })

  it('throws for an unknown task', async () => {
    const { deps } = makeDeps()
    await expect(switchTask(deps, { taskId: asTaskId('ghost') })).rejects.toThrow(
      InvariantViolationError
    )
  })
})

describe('switchTask scrollback restore (§6.6)', () => {
  it('replays persisted scrollback as a ptyData event BEFORE sessionCreated, with a separator', async () => {
    const fd = makeDeps({ snapshot: restoredSnapshot() })
    // Seed persisted output for t2's restored session (as a prior quit would have).
    fd.persistence.saveScrollback(asSessionId('t2-s1'), 'PRIOR OUTPUT')

    await switchTask(fd.deps, { taskId: asTaskId('t2') })

    // The replay is a normal ptyData event carrying history + the dim separator.
    const replay = fd.bus.ofType('ptyData').find((e) => e.sessionId === asSessionId('t2-s1'))
    expect(replay).toBeDefined()
    expect(replay!.data).toContain('PRIOR OUTPUT')
    expect(replay!.data).toContain('session restored')

    // Ordering is load-bearing: the replay must precede sessionCreated so it lands
    // in the renderer's pre-mount buffer ahead of the running-lifecycle upsert.
    const replayIdx = fd.bus.events.indexOf(replay!)
    const createdIdx = fd.bus.events.findIndex(
      (e) => e.type === 'sessionCreated' && e.session.id === asSessionId('t2-s1')
    )
    expect(replayIdx).toBeGreaterThanOrEqual(0)
    expect(createdIdx).toBeGreaterThan(replayIdx)

    // History is rotated into the persisted frozen part (not main's live buffer), so it
    // accumulates across restarts without a later save overwriting it.
    expect(fd.persistence.savedScrollback.get(asSessionId('t2-s1'))).toEqual({
      history: 'PRIOR OUTPUT',
      live: ''
    })
    expect(fd.scrollbacks.snapshot(asSessionId('t2-s1'))).toBeUndefined()
  })

  it('publishes no extra ptyData when the restored session has no persisted scrollback', async () => {
    const fd = makeDeps({ snapshot: restoredSnapshot() })

    await switchTask(fd.deps, { taskId: asTaskId('t2') })

    // No history was stored → no replay event (the fresh PTY output flows normally).
    expect(fd.bus.ofType('ptyData')).toEqual([])
  })
})
