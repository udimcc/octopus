import { describe, it, expect } from 'vitest'
import {
  taskToRow,
  sessionToRow,
  rowToTaskSnapshot,
  rowToSessionSnapshot,
  type SessionRow
} from './mappers'
import { asTaskId, asSessionId, asTypeId } from '../../domain/ids'
import { TaskState, SessionState } from '../../domain/state'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import type { TaskSnapshot, SessionSnapshot } from '../../domain/snapshots'

function sessionSnapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: asSessionId('s1'),
    taskId: asTaskId('t1'),
    typeId: asTypeId('terminal'),
    title: 'shell',
    config: { kind: 'terminal', shell: '/bin/zsh', initialCommand: 'ls', cwdOverride: '/wt' },
    lifecycle: SessionLifecycle.Running,
    state: SessionState.Unknown,
    order: 0,
    createdAt: 100,
    ...over
  }
}

function taskSnapshot(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: asTaskId('t1'),
    name: 'my task',
    worktree: {
      path: '/repo/.worktrees/t1',
      branch: 'feature/x',
      baseRef: 'main',
      provisionedBy: { script: '/s/create.sh', args: ['a'], repoRoot: '/repo', provisionedAt: 5 }
    },
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [],
    activeSessionId: asSessionId('s1'),
    position: 2,
    createdAt: 100,
    ...over
  }
}

describe('taskToRow (§6.3)', () => {
  it('maps a Ready task, flattening the worktree', () => {
    const row = taskToRow(taskSnapshot())
    expect(row).toEqual({
      id: 't1',
      name: 'my task',
      worktree: '/repo/.worktrees/t1',
      branch: 'feature/x',
      base_ref: 'main',
      repo_root: '/repo',
      created_at: 100,
      position: 2,
      active_session_id: 's1'
    })
  })

  it('nulls optional columns (branch, active session) rather than storing undefined', () => {
    const snap = taskSnapshot({
      worktree: {
        path: '/wt',
        provisionedBy: { script: '', args: [], repoRoot: '', provisionedAt: 0 }
      },
      activeSessionId: undefined
    })
    const row = taskToRow(snap)
    expect(row.branch).toBeNull()
    expect(row.base_ref).toBeNull()
    expect(row.repo_root).toBeNull()
    expect(row.active_session_id).toBeNull()
  })

  it('refuses to persist a task with no worktree (§6.3: only provisioned tasks persist)', () => {
    expect(() => taskToRow(taskSnapshot({ worktree: undefined }))).toThrow(/no worktree/)
  })
})

describe('sessionToRow (§6.3, §10)', () => {
  it('serializes the full config as JSON and denormalizes shell', () => {
    const row = sessionToRow(sessionSnapshot())
    expect(row.shell).toBe('/bin/zsh')
    expect(JSON.parse(row.config)).toEqual({
      kind: 'terminal',
      shell: '/bin/zsh',
      initialCommand: 'ls',
      cwdOverride: '/wt'
    })
    expect(row.type).toBe('terminal')
    expect(row.label).toBe('shell')
    expect(row.position).toBe(0)
  })

  it('nulls shell and exited_at when absent', () => {
    const row = sessionToRow(sessionSnapshot({ config: { kind: 'terminal' }, exitedAt: undefined }))
    expect(row.shell).toBeNull()
    expect(row.exited_at).toBeNull()
  })

  it('writes exited_at and state for record fidelity', () => {
    const row = sessionToRow(
      sessionSnapshot({
        lifecycle: SessionLifecycle.Exited,
        exitedAt: 999,
        state: SessionState.Blocked
      })
    )
    expect(row.exited_at).toBe(999)
    expect(row.state).toBe('blocked')
  })
})

describe('rowToSessionSnapshot (I13, §6.3 — fresh on reload)', () => {
  it('resets lifecycle to Created and state to Unknown, clearing exit time', () => {
    const row: SessionRow = {
      id: 's9',
      task_id: 't1',
      type: 'terminal',
      label: 'build',
      shell: '/bin/bash',
      config: JSON.stringify({ kind: 'terminal', shell: '/bin/bash' }),
      position: 3,
      state: 'blocked',
      created_at: 42,
      exited_at: 777
    }
    const snap = rowToSessionSnapshot(row)
    expect(snap.lifecycle).toBe(SessionLifecycle.Created)
    expect(snap.state).toBe(SessionState.Unknown)
    expect(snap.exitedAt).toBeUndefined()
    expect(snap.config).toEqual({ kind: 'terminal', shell: '/bin/bash' })
    expect(snap.order).toBe(3)
    expect(snap.title).toBe('build')
  })
})

describe('rowToTaskSnapshot (I13/I14, §6.3)', () => {
  it('reloads a task as Ready with Unknown state and its ordered sessions', () => {
    const taskRow = {
      id: 't1',
      name: 'my task',
      worktree: '/wt',
      branch: 'feature/x',
      base_ref: 'main',
      repo_root: '/repo',
      created_at: 100,
      position: 2,
      active_session_id: 's1'
    }
    const sessionRows: SessionRow[] = [
      {
        id: 's1',
        task_id: 't1',
        type: 'terminal',
        label: 'a',
        shell: null,
        config: JSON.stringify({ kind: 'terminal' }),
        position: 0,
        state: 'unknown',
        created_at: 100,
        exited_at: null
      }
    ]
    const snap = rowToTaskSnapshot(taskRow, sessionRows)
    expect(snap.lifecycle).toBe(TaskLifecycle.Ready)
    expect(snap.state).toBe(TaskState.Unknown)
    expect(snap.worktree?.path).toBe('/wt')
    expect(snap.worktree?.branch).toBe('feature/x')
    expect(snap.worktree?.baseRef).toBe('main')
    expect(snap.activeSessionId).toBe(asSessionId('s1'))
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0].id).toBe(asSessionId('s1'))
  })

  it('drops the active pointer when null and maps missing branch/repo_root to undefined/empty', () => {
    const snap = rowToTaskSnapshot(
      {
        id: 't1',
        name: 't',
        worktree: '/wt',
        branch: null,
        base_ref: null,
        repo_root: null,
        created_at: 1,
        position: 0,
        active_session_id: null
      },
      []
    )
    expect(snap.activeSessionId).toBeUndefined()
    expect(snap.worktree?.branch).toBeUndefined()
    expect(snap.worktree?.baseRef).toBeUndefined()
    expect(snap.worktree?.provisionedBy.repoRoot).toBe('')
  })
})

describe('round-trip (write then read, minus live state — I13)', () => {
  it('preserves the definition through row and back', () => {
    const original = taskSnapshot({
      sessions: [sessionSnapshot()],
      // baseRef + repoRoot round-trip via base_ref/repo_root (§6.4 restart-delete).
      worktree: {
        path: '/repo/.worktrees/t1',
        branch: 'feature/x',
        baseRef: 'main',
        provisionedBy: { script: 's', args: ['a'], repoRoot: '/repo', provisionedAt: 5 }
      }
    })
    const taskRow = taskToRow(original)
    const sessionRows = original.sessions.map(sessionToRow)
    const restored = rowToTaskSnapshot(taskRow, sessionRows)

    expect(restored.id).toBe(original.id)
    expect(restored.name).toBe(original.name)
    expect(restored.position).toBe(original.position)
    expect(restored.worktree?.path).toBe(original.worktree!.path)
    expect(restored.worktree?.branch).toBe(original.worktree!.branch)
    expect(restored.worktree?.baseRef).toBe(original.worktree!.baseRef)
    expect(restored.worktree?.provisionedBy.repoRoot).toBe(original.worktree!.provisionedBy.repoRoot)
    expect(restored.sessions[0].config).toEqual(original.sessions[0].config)
    expect(restored.sessions[0].title).toBe(original.sessions[0].title)
    // Live state is intentionally NOT round-tripped.
    expect(restored.sessions[0].lifecycle).toBe(SessionLifecycle.Created)
  })
})
