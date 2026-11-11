/**
 * Lazy restore-start of a task's sessions (DESIGN §6.3, §5.3). Focuses on the
 * ordering guarantee that makes restore feel instant: persisted scrollback is
 * loaded + published as `ptyData` BEFORE the PTY spawn and before `sessionCreated`,
 * so history paints without waiting on the shell fork — and is published even when
 * the spawn later fails (history is independent of the live PTY, I13). Also covers
 * the frozen-history / live split (§6.6, schema v13) across fresh spawns and daemon
 * re-attaches: no history lost, none printed twice.
 */

import { describe, it, expect } from 'vitest'
import { startTaskSessions } from './start-task-sessions'
import { handleRuntimeExit } from './handle-runtime-exit'
import { makeDeps } from './test-fakes'
import { asTaskId, asSessionId, asTypeId } from '../../domain/ids'
import { SessionLifecycle, TaskLifecycle } from '../../domain/lifecycle'
import { SessionState, TaskState } from '../../domain/state'
import type { WorkspaceSnapshot } from '../../domain/snapshots'
import type { DomainEvent } from '../../ports/event-bus'
import type { PersistedScrollback } from '../../ports/workspace-persistence'
import type { SessionId } from '../../domain/ids'
import { shutdown } from '../quit'

/** A restored snapshot: one Ready task with one fresh `Created` session. */
function restoredSnapshot(taskId: string, sessionId: string, path = '/wt/task'): WorkspaceSnapshot {
  return {
    tasks: [
      {
        id: asTaskId(taskId),
        name: taskId,
        worktree: {
          path,
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
    // Rotated into the frozen history; NOT re-appended to main's live buffer, so a later
    // save (which writes only the live part) can never overwrite or duplicate it.
    expect(f.persistence.savedScrollback.get(sessionId)).toEqual({
      history: 'PRIOR_OUTPUT',
      live: ''
    })
    expect(f.scrollbacks.snapshot(sessionId)).toBeUndefined()
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

  it('strips query-request sequences from the restored history (no replayed-query garbage)', async () => {
    const taskId = asTaskId('task-1')
    const sessionId = asSessionId('session-1')
    const f = makeDeps({ snapshot: restoredSnapshot('task-1', 'session-1') })
    // Raw history with a DA1 request and an OSC 11 bg-color query embedded — the two
    // whose replies produced the `0;276;0c` / `11;rgb:…` echo garbage on restore.
    f.persistence.saveScrollback(sessionId, 'PRIOR_OUTPUT\x1b[c\x1b]11;?\x07')

    await startTaskSessions(f.deps, taskId)

    const historyIdx = f.bus.events.findIndex(
      (e) => e.type === 'ptyData' && e.data.includes('PRIOR_OUTPUT')
    )
    const history = f.bus.events[historyIdx]
    expect(history.type === 'ptyData' && history.data).toContain('session restored')
    // Query requests were stripped from the display copy so xterm answers none of them.
    expect(history.type === 'ptyData' && history.data).not.toContain('\x1b[c')
    expect(history.type === 'ptyData' && history.data).not.toContain('\x1b]11;?')
    // But the raw bytes are still kept in the persisted history for the next restart.
    expect(f.persistence.savedScrollback.get(sessionId)!.history).toContain('\x1b[c')
  })

  it('emits no history event when there is no persisted scrollback', async () => {
    const taskId = asTaskId('task-1')
    const f = makeDeps({ snapshot: restoredSnapshot('task-1', 'session-1') })

    await startTaskSessions(f.deps, taskId)

    expect(f.bus.ofType('ptyData')).toHaveLength(0)
    expect(f.bus.ofType('sessionCreated')).toHaveLength(1)
  })

  it('a StartFailed tab does not grow its history on the next boot (rotation is idempotent)', async () => {
    const taskId = asTaskId('task-1')
    const sessionId = asSessionId('session-1')
    const f = makeDeps({ snapshot: restoredSnapshot('task-1', 'session-1') })
    f.persistence.saveScrollback(sessionId, 'PRIOR_OUTPUT')
    f.sessions.failNextStartWith = new Error('spawn boom')
    await startTaskSessions(f.deps, taskId)

    const next = makeDeps({ snapshot: restoredSnapshot('task-1', 'session-1') })
    next.persistence.savedScrollback.set(sessionId, f.persistence.savedScrollback.get(sessionId)!)
    await startTaskSessions(next.deps, taskId)

    expect(next.persistence.savedScrollback.get(sessionId)!.history).toBe('PRIOR_OUTPUT')
    expect(next.persistence.rotations).toHaveLength(0) // nothing to fold → no rewrite
  })
})

describe('startTaskSessions daemon re-attach (§6.2, §6.6)', () => {
  const taskId = asTaskId('task-1')
  const sessionId = asSessionId('session-1')

  function reattachDeps(): ReturnType<typeof makeDeps> {
    return makeDeps({
      snapshot: restoredSnapshot('task-1', 'session-1'),
      liveDaemonSessions: new Set([sessionId])
    })
  }

  it('paints only the frozen history, then the replay fills the live part', async () => {
    const f = reattachDeps()
    f.persistence.savedScrollback.set(sessionId, { history: 'FROZEN', live: 'LIVE' })
    f.sessions.replays.set(sessionId, 'LIVE')

    await startTaskSessions(f.deps, taskId)

    const data = f.bus.ofType('ptyData').map((e) => e.data)
    expect(data).toHaveLength(2)
    expect(data[0]).toContain('FROZEN')
    expect(data[0]).toContain('session restored')
    expect(data[0]).not.toContain('LIVE') // the DB live part is never painted on re-attach
    expect(data[1]).toBe('LIVE') // the daemon replay
    expect(f.scrollbacks.snapshot(sessionId)).toBe('LIVE')
    expect(f.sessions.last()!.ctx.resume).toBe(true)
    expect(f.persistence.rotations).toHaveLength(0)
    expect(f.workspace.task(taskId)!.session(sessionId)!.lifecycle).toBe(SessionLifecycle.Running)
  })

  it('paints nothing from the DB when there is no frozen history', async () => {
    const f = reattachDeps()
    f.persistence.saveScrollback(sessionId, 'PRIOR_OUTPUT') // live only, history ''
    await startTaskSessions(f.deps, taskId)
    expect(f.bus.ofType('ptyData')).toHaveLength(0)
    expect(f.bus.ofType('sessionCreated')).toHaveLength(1)
  })

  it('splits a legacy (pre-v13) row once, keeping only what the replay lacks', async () => {
    const f = reattachDeps()
    // Pre-v13: one blob = history restored at an earlier fresh spawn + daemon output.
    const ring = '|RING line 1\r\nRING line 2\r\nRING line 3\r\n'
    f.persistence.savedScrollback.set(sessionId, { history: null, live: 'OLD_HISTORY' + ring })
    f.sessions.replays.set(sessionId, ring)

    await startTaskSessions(f.deps, taskId)

    expect(f.persistence.savedScrollback.get(sessionId)!.history).toBe('OLD_HISTORY')
    // This run shows just the replay (the split shows from the next restart on).
    expect(f.bus.ofType('ptyData').map((e) => e.data)).toEqual([ring])
  })

  it('a legacy row survives a replay that is only the mode-restore sequence', async () => {
    // Regression from real data: an empty daemon ring replays just the restore modes,
    // which a legacy row that was itself a replay starts with. The split must keep it
    // all, so the live save that follows (here: the daemon dying) loses nothing.
    const f = reattachDeps()
    const restore = '\x1b[?25l\x1b[?1004h\x1b[?2004h'
    const legacy = restore + 'CLAUDE CONVERSATION'
    f.persistence.savedScrollback.set(sessionId, { history: null, live: legacy })
    f.sessions.replays.set(sessionId, restore)

    await startTaskSessions(f.deps, taskId)
    f.sessions.last()!.ctx.onData('$ ')
    // The daemon died: its synthetic exit saves the live part (handleRuntimeExit).
    handleRuntimeExit(f.deps, { sessionId, exitCode: 0 })

    expect(f.persistence.savedScrollback.get(sessionId)).toEqual({
      history: legacy,
      live: restore + '$ '
    })
  })

  it('a failed re-attach shows the saved live part instead of a blank pane', async () => {
    const f = reattachDeps()
    f.persistence.savedScrollback.set(sessionId, { history: 'FROZEN', live: 'LIVE' })
    f.sessions.failNextStartWith = new Error('no such session')

    await startTaskSessions(f.deps, taskId)

    const data = f.bus.ofType('ptyData').map((e) => e.data)
    expect(data).toHaveLength(2)
    expect(data[0]).toContain('FROZEN')
    expect(data[1]).toContain('LIVE')
    expect(f.workspace.task(taskId)!.session(sessionId)!.lifecycle).toBe(
      SessionLifecycle.StartFailed
    )
    // The row is untouched; the next boot fresh-spawns and folds LIVE into history.
    expect(f.persistence.savedScrollback.get(sessionId)).toEqual({
      history: 'FROZEN',
      live: 'LIVE'
    })
  })

  it('a re-attach that fails after its replay arrived saves none of it', async () => {
    const f = reattachDeps()
    f.persistence.savedScrollback.set(sessionId, { history: null, live: 'LEGACY OUTPUT' })
    f.sessions.replays.set(sessionId, 'PARTIAL REPLAY')
    f.sessions.failNextStartWith = new Error('daemon connection lost')

    await startTaskSessions(f.deps, taskId)

    // Nothing is left for a flush to write over the stored row.
    expect(f.scrollbacks.snapshot(sessionId)).toBeUndefined()
    expect(f.persistence.savedScrollback.get(sessionId)).toEqual({
      history: null,
      live: 'LEGACY OUTPUT'
    })
  })
})

describe('startTaskSessions restart loop: no lost and no doubled history (§6.6)', () => {
  const taskId = asTaskId('task-1')
  const sessionId = asSessionId('session-1')

  /**
   * One app run: restore the session (re-attach if the daemon still has it), print
   * `output`, quit (flush). `ring` models the daemon's buffer, which survives app
   * restarts but not a daemon death. Returns everything the pane was shown.
   */
  async function appRun(
    db: Map<SessionId, PersistedScrollback>,
    daemon: { ring: string | undefined },
    output: string
  ): Promise<string> {
    const resume = daemon.ring !== undefined
    const f = makeDeps({
      snapshot: restoredSnapshot('task-1', 'session-1'),
      liveDaemonSessions: resume ? new Set([sessionId]) : undefined
    })
    for (const [id, row] of db) f.persistence.savedScrollback.set(id, row)
    if (resume) f.sessions.replays.set(sessionId, daemon.ring!)
    else daemon.ring = '' // fresh spawn: a new daemon PTY with an empty ring

    await startTaskSessions(f.deps, taskId)
    // What the pane showed on restore (before this run's own output).
    const display = f.bus
      .ofType('ptyData')
      .map((e) => e.data)
      .join('')
    f.sessions.last()!.ctx.onData(output)
    daemon.ring += output
    shutdown(f.deps)

    db.clear()
    for (const [id, row] of f.persistence.savedScrollback) db.set(id, row)
    return display
  }

  it('fresh → re-attach → re-attach → (daemon dies) fresh → re-attach → re-attach', async () => {
    const db = new Map<SessionId, PersistedScrollback>()
    const daemon: { ring: string | undefined } = { ring: undefined }
    const count = (s: string, needle: string): number => s.split(needle).length - 1

    await appRun(db, daemon, '<A>')
    expect(await appRun(db, daemon, '<B>')).toBe('<A>')
    expect(await appRun(db, daemon, '<C>')).toBe('<A><B>')

    daemon.ring = undefined // reboot / daemon restart
    const afterRespawn = await appRun(db, daemon, '<D>')
    expect(afterRespawn).toContain('<A><B><C>')
    expect(afterRespawn).toContain('session restored')

    // The bug: these re-attaches used to drop <A><B><C> from both the pane and the DB.
    for (const [output, shown] of [
      ['<E>', '<D>'],
      ['<F>', '<D><E>']
    ] as const) {
      const display = await appRun(db, daemon, output)
      for (const marker of ['<A>', '<B>', '<C>']) {
        expect(count(display, marker)).toBe(1)
      }
      expect(display.endsWith(shown)).toBe(true)
      expect(count(display, '<D>')).toBe(1)
    }
    expect(db.get(sessionId)).toEqual({ history: '<A><B><C>', live: '<D><E><F>' })

    daemon.ring = undefined
    const last = await appRun(db, daemon, '<G>')
    expect(last).toContain('<A><B><C><D><E><F>')
    expect(count(last, '<D>')).toBe(1)
  })
})
