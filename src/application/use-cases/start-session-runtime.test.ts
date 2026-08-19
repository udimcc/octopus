/**
 * Runtime-start core, spawn-vs-attach seam (DESIGN §6.2, §6.1, §10). Focuses on the
 * cwd-placement and `resume` decisions the durable daemon backend added — all
 * additive and inert on the in-process path (empty `liveDaemonSessions` → every
 * branch reduces to today's fresh-spawn behavior).
 */

import { describe, it, expect } from 'vitest'
import { startSessionRuntime } from './start-session-runtime'
import { makeDeps } from './test-fakes'
import { asTaskId, asSessionId, asTypeId, type SessionId } from '../../domain/ids'
import { SessionLifecycle, TaskLifecycle } from '../../domain/lifecycle'
import { SessionState, TaskState } from '../../domain/state'
import type { WorkspaceSnapshot } from '../../domain/snapshots'
import type { SessionConfig } from '../../domain/session-config'

/** One Ready task with one `Created` terminal session carrying `config`. */
function snapshot(
  path: string,
  config: SessionConfig = { kind: 'terminal' }
): WorkspaceSnapshot {
  return {
    tasks: [
      {
        id: asTaskId('task-1'),
        name: 'task-1',
        worktree: {
          path,
          managed: true,
          provisionedBy: { script: 'git', args: ['task-1'], repoRoot: '/repo', provisionedAt: 1 }
        },
        lifecycle: TaskLifecycle.Ready,
        state: TaskState.Unknown,
        sessions: [
          {
            id: asSessionId('session-1'),
            taskId: asTaskId('task-1'),
            typeId: asTypeId('terminal'),
            title: 'Terminal 1',
            config,
            lifecycle: SessionLifecycle.Created,
            state: SessionState.Unknown,
            order: 0,
            createdAt: 1
          }
        ],
        activeSessionId: asSessionId('session-1'),
        position: 0,
        createdAt: 1
      }
    ],
    activeTaskId: asTaskId('task-1')
  }
}

/** One Ready "No Repo" task (§5.4): no worktree, `repoLess: true`. */
function noRepoSnapshot(config: SessionConfig = { kind: 'terminal' }): WorkspaceSnapshot {
  return {
    tasks: [
      {
        id: asTaskId('task-1'),
        name: 'scratch',
        worktree: undefined,
        repoLess: true,
        lifecycle: TaskLifecycle.Ready,
        state: TaskState.Unknown,
        sessions: [
          {
            id: asSessionId('session-1'),
            taskId: asTaskId('task-1'),
            typeId: asTypeId('terminal'),
            title: 'Terminal 1',
            config,
            lifecycle: SessionLifecycle.Created,
            state: SessionState.Unknown,
            order: 0,
            createdAt: 1
          }
        ],
        activeSessionId: asSessionId('session-1'),
        position: 0,
        createdAt: 1
      }
    ],
    activeTaskId: asTaskId('task-1')
  }
}

const TASK = asTaskId('task-1')
const SESSION = asSessionId('session-1')

/** Run startSessionRuntime against the single restored session in `f`. */
async function run(f: ReturnType<typeof makeDeps>): Promise<void> {
  const task = f.workspace.task(TASK)!
  await startSessionRuntime(f.deps, task, task.session(SESSION)!, task.worktree)
}

describe('startSessionRuntime spawn-vs-attach seam (§6.2)', () => {
  it('in-process (empty roster): fresh spawn at the worktree cwd, resume false', async () => {
    const f = makeDeps({ snapshot: snapshot('/wt/task') })
    await run(f)
    const ctx = f.sessions.last()!.ctx
    expect(ctx.resume).toBe(false)
    expect(ctx.worktreePath).toBe('/wt/task')
    expect(f.workspace.task(TASK)!.session(SESSION)!.lifecycle).toBe(SessionLifecycle.Running)
  })

  it('fresh spawn prefers the persisted last_cwd over the worktree root (§6.2)', async () => {
    const f = makeDeps({ snapshot: snapshot('/wt/task') })
    f.persistence.saveLastCwd(SESSION, '/wt/task/deep/sub')
    await run(f)
    expect(f.sessions.last()!.ctx.worktreePath).toBe('/wt/task/deep/sub')
  })

  it('fresh spawn: config cwdOverride wins when there is no last_cwd', async () => {
    const f = makeDeps({
      snapshot: snapshot('/wt/task', { kind: 'terminal', cwdOverride: '/wt/task/override' })
    })
    await run(f)
    expect(f.sessions.last()!.ctx.worktreePath).toBe('/wt/task/override')
  })

  it('re-attach (id in live roster): resume true and last_cwd is NOT consulted', async () => {
    const f = makeDeps({
      snapshot: snapshot('/wt/task'),
      liveDaemonSessions: new Set<SessionId>([SESSION])
    })
    // A stale last_cwd must be ignored on re-attach — the live process owns its cwd.
    f.persistence.saveLastCwd(SESSION, '/wt/task/stale')
    await run(f)
    const ctx = f.sessions.last()!.ctx
    expect(ctx.resume).toBe(true)
    // cwd falls back to the worktree (unused by the runtime on attach), NOT last_cwd.
    expect(ctx.worktreePath).toBe('/wt/task')
  })

  it('delivers the configured initial command on a FRESH spawn', async () => {
    const f = makeDeps({
      snapshot: snapshot('/wt/task', { kind: 'terminal', initialCommand: 'npm run dev' })
    })
    await run(f)
    expect(f.sessions.last()!.writes).toContain('npm run dev\n')
  })

  it('SUPPRESSES the initial command on a re-attach (shell already exists, §6.2)', async () => {
    const f = makeDeps({
      snapshot: snapshot('/wt/task', { kind: 'terminal', initialCommand: 'npm run dev' }),
      liveDaemonSessions: new Set<SessionId>([SESSION])
    })
    await run(f)
    expect(f.sessions.last()!.writes).toHaveLength(0)
  })

  it('"No Repo" task (no worktree): fresh spawn falls back to the home dir (§5.4)', async () => {
    const f = makeDeps({ snapshot: noRepoSnapshot() })
    await run(f)
    const ctx = f.sessions.last()!.ctx
    expect(ctx.resume).toBe(false)
    // No last_cwd, no cwdOverride, no worktree → deps.homeDir.
    expect(ctx.worktreePath).toBe('/home/test')
    expect(f.workspace.task(TASK)!.session(SESSION)!.lifecycle).toBe(SessionLifecycle.Running)
  })

  it('"No Repo" task: a persisted last_cwd still wins over the home dir (§6.2)', async () => {
    const f = makeDeps({ snapshot: noRepoSnapshot() })
    f.persistence.saveLastCwd(SESSION, '/var/log')
    await run(f)
    expect(f.sessions.last()!.ctx.worktreePath).toBe('/var/log')
  })

  it('on start failure: marks StartFailed, disposes, emits error, and rethrows', async () => {
    const f = makeDeps({ snapshot: snapshot('/wt/task') })
    f.sessions.failNextStartWith = new Error('spawn boom')
    await expect(run(f)).rejects.toThrow('spawn boom')
    expect(f.workspace.task(TASK)!.session(SESSION)!.lifecycle).toBe(SessionLifecycle.StartFailed)
    expect(f.sessions.last()!.disposed).toBe(true)
    expect(f.bus.ofType('error')).toHaveLength(1)
  })
})
