/**
 * Lazy restore-start of a task's sessions (DESIGN §6.3, §5.3). Focuses on the
 * ordering guarantee that makes restore feel instant: persisted scrollback is
 * loaded + published as `ptyData` BEFORE the PTY spawn and before `sessionCreated`,
 * so history paints without waiting on the shell fork — and is published even when
 * the spawn later fails (history is independent of the live PTY, I13).
 */

import { describe, it, expect } from 'vitest'
import { startTaskSessions } from './start-task-sessions'
import { makeDeps } from './test-fakes'
import { asTaskId, asSessionId, asTypeId } from '../../domain/ids'
import { SessionLifecycle, TaskLifecycle } from '../../domain/lifecycle'
import { SessionState, TaskState } from '../../domain/state'
import type { WorkspaceSnapshot } from '../../domain/snapshots'
import type { DomainEvent } from '../../ports/event-bus'

/** A restored snapshot: one Ready task with one fresh `Created` session. */
function restoredSnapshot(taskId: string, sessionId: string, path = '/wt/task'): WorkspaceSnapshot {
  return {
    tasks: [
      {
        id: asTaskId(taskId),
        name: taskId,
        worktree: {
          path,
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
        position: 0,
        createdAt: 1
      }
    ],
    activeTaskId: asTaskId(taskId)
  }
}

describe('startTaskSessions restore ordering (§6.3)', () => {
  it('publishes persisted history as ptyData before sessionCreated', async () => {
    const taskId = asTaskId('task-1')
    const sessionId = asSessionId('session-1')
    const f = makeDeps({ snapshot: restoredSnapshot('task-1', 'session-1') })
    f.persistence.saveScrollback(sessionId, 'PRIOR_OUTPUT')

    await startTaskSessions(f.deps, taskId)

    // The history ptyData carries the prior output + the restore marker, and it
    // precedes the sessionCreated upsert.
    const types = f.bus.events.map((e: DomainEvent) => e.type)
    const historyIdx = f.bus.events.findIndex(
      (e) => e.type === 'ptyData' && e.data.includes('PRIOR_OUTPUT')
    )
    const createdIdx = types.indexOf('sessionCreated')
    expect(historyIdx).toBeGreaterThanOrEqual(0)
    expect(createdIdx).toBeGreaterThanOrEqual(0)
    expect(historyIdx).toBeLessThan(createdIdx)

    const history = f.bus.events[historyIdx]
    expect(history.type === 'ptyData' && history.data).toContain('session restored')
    // Re-appended to the live buffer so it keeps accumulating across restarts.
    expect(f.scrollbacks.snapshot(sessionId)).toContain('PRIOR_OUTPUT')
    // The session actually started (fake runtime).
    expect(f.workspace.task(taskId)!.session(sessionId)!.lifecycle).toBe(SessionLifecycle.Running)
  })

  it('still publishes history when the PTY spawn fails (StartFailed tab keeps its output)', async () => {
    const taskId = asTaskId('task-1')
    const sessionId = asSessionId('session-1')
    const f = makeDeps({ snapshot: restoredSnapshot('task-1', 'session-1') })
    f.persistence.saveScrollback(sessionId, 'PRIOR_OUTPUT')
    f.sessions.failNextStartWith = new Error('spawn boom')

    await startTaskSessions(f.deps, taskId)

    // History was published even though the spawn failed and no sessionCreated fired.
    const historyIdx = f.bus.events.findIndex(
      (e) => e.type === 'ptyData' && e.data.includes('PRIOR_OUTPUT')
    )
    expect(historyIdx).toBeGreaterThanOrEqual(0)
    expect(f.bus.ofType('sessionCreated')).toHaveLength(0)
    // startSessionRuntime surfaced the failure and left the tab StartFailed.
    expect(f.bus.ofType('error')).toHaveLength(1)
    expect(f.workspace.task(taskId)!.session(sessionId)!.lifecycle).toBe(
      SessionLifecycle.StartFailed
    )
  })

  it('emits no history event when there is no persisted scrollback', async () => {
    const taskId = asTaskId('task-1')
    const f = makeDeps({ snapshot: restoredSnapshot('task-1', 'session-1') })

    await startTaskSessions(f.deps, taskId)

    expect(f.bus.ofType('ptyData')).toHaveLength(0)
    expect(f.bus.ofType('sessionCreated')).toHaveLength(1)
  })
})
