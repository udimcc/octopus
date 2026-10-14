import { describe, it, expect } from 'vitest'
import {
  taskToRow,
  sessionToRow,
  rowToTaskSnapshot,
  rowToSessionSnapshot,
  issueToRow,
  rowToIssueSnapshot,
  type SessionRow,
  type IssueRow
} from './mappers'
import { asTaskId, asSessionId, asTypeId, asWindowId, asIssueId } from '../../domain/ids'
import { TaskState, SessionState } from '../../domain/state'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import { IssueStatus } from '../../domain/issue'
import type { TaskSnapshot, SessionSnapshot, IssueSnapshot } from '../../domain/snapshots'

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
      managed: true,
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
      active_session_id: 's1',
      managed: 1,
      repo_less: 0
    })
  })

  it('maps an adopted worktree (managed: false) to managed = 0', () => {
    const row = taskToRow(
      taskSnapshot({
        worktree: {
          path: '/home/u/project',
          managed: false,
          provisionedBy: {
            script: 'adopt',
            args: [],
            repoRoot: '/home/u/project',
            provisionedAt: 5
          }
        }
      })
    )
    expect(row.managed).toBe(0)
  })

  it('nulls optional columns (branch, active session) rather than storing undefined', () => {
    const snap = taskSnapshot({
      worktree: {
        path: '/wt',
        managed: true,
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

  it('refuses to persist a worktree-less, non-repo-less task (§6.3: only provisioned tasks persist)', () => {
    expect(() => taskToRow(taskSnapshot({ worktree: undefined }))).toThrow(/no worktree/)
  })

  it('persists a "No Repo" task with worktree = \'\' + repo_less = 1 (§5.4)', () => {
    const row = taskToRow(taskSnapshot({ worktree: undefined, repoLess: true }))
    expect(row.repo_less).toBe(1)
    expect(row.worktree).toBe('')
    // No repo/branch provenance and never Octopus-managed (nothing to delete).
    expect(row.branch).toBeNull()
    expect(row.base_ref).toBeNull()
    expect(row.repo_root).toBeNull()
    expect(row.managed).toBe(0)
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
        state: SessionState.NeedsInput
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
      exited_at: 777,
      window_id: 'win-2'
    }
    const snap = rowToSessionSnapshot(row)
    expect(snap.lifecycle).toBe(SessionLifecycle.Created)
    expect(snap.state).toBe(SessionState.Unknown)
    expect(snap.exitedAt).toBeUndefined()
    expect(snap.config).toEqual({ kind: 'terminal', shell: '/bin/bash' })
    expect(snap.order).toBe(3)
    expect(snap.title).toBe('build')
    // V1.5 (I18): the window assignment round-trips on reload so a restored
    // session reappears in its window, unlike the reset lifecycle/state above.
    expect(snap.windowId).toBe(asWindowId('win-2'))
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
      active_session_id: 's1',
      managed: 1,
      repo_less: 0
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
        exited_at: null,
        window_id: 'main'
      }
    ]
    const snap = rowToTaskSnapshot(taskRow, sessionRows)
    expect(snap.lifecycle).toBe(TaskLifecycle.Ready)
    expect(snap.state).toBe(TaskState.Unknown)
    expect(snap.worktree?.path).toBe('/wt')
    expect(snap.worktree?.branch).toBe('feature/x')
    expect(snap.worktree?.baseRef).toBe('main')
    expect(snap.worktree?.managed).toBe(true)
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
        active_session_id: null,
        managed: 0,
        repo_less: 0
      },
      []
    )
    expect(snap.activeSessionId).toBeUndefined()
    expect(snap.worktree?.branch).toBeUndefined()
    expect(snap.worktree?.baseRef).toBeUndefined()
    expect(snap.worktree?.provisionedBy.repoRoot).toBe('')
    // An adopted row (managed = 0) reloads as an unmanaged worktree.
    expect(snap.worktree?.managed).toBe(false)
  })

  it('reloads a repo_less row as a Ready task with NO worktree, before reading the sentinel path (§5.4)', () => {
    const snap = rowToTaskSnapshot(
      {
        id: 't1',
        name: 'scratch',
        worktree: '', // sentinel — must NOT be read as a path
        branch: null,
        base_ref: null,
        repo_root: null,
        created_at: 1,
        position: 0,
        active_session_id: null,
        managed: 0,
        repo_less: 1
      },
      []
    )
    expect(snap.repoLess).toBe(true)
    expect(snap.worktree).toBeUndefined()
    expect(snap.lifecycle).toBe(TaskLifecycle.Ready)
    expect(snap.state).toBe(TaskState.Unknown)
  })
})

function issueSnapshot(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    id: asIssueId('i1'),
    name: 'issue',
    description: 'desc',
    projectPath: '/repo',
    status: IssueStatus.InProgress,
    taskId: asTaskId('t1'),
    createdAt: 10,
    updatedAt: 20,
    ...over
  }
}

describe('issueToRow / rowToIssueSnapshot (I19, v8)', () => {
  it('round-trips a fully-populated issue', () => {
    const row = issueToRow(issueSnapshot())
    expect(row).toEqual({
      id: 'i1',
      name: 'issue',
      description: 'desc',
      project_path: '/repo',
      status: 'in_progress',
      task_id: 't1',
      created_at: 10,
      updated_at: 20
    })
    const restored = rowToIssueSnapshot(row)
    expect(restored).toEqual(issueSnapshot())
  })

  it('round-trips a null project and null task as undefined', () => {
    const original = issueSnapshot({ projectPath: undefined, taskId: undefined })
    const row = issueToRow(original)
    expect(row.project_path).toBeNull()
    expect(row.task_id).toBeNull()
    const restored = rowToIssueSnapshot(row)
    expect(restored.projectPath).toBeUndefined()
    expect(restored.taskId).toBeUndefined()
    expect(restored).toEqual(original)
  })

  it('falls back to Todo for a corrupt/unrecognized status string', () => {
    const row: IssueRow = {
      id: 'i1',
      name: 'issue',
      description: '',
      project_path: null,
      status: 'bogus-not-a-real-status',
      task_id: null,
      created_at: 1,
      updated_at: 1
    }
    expect(rowToIssueSnapshot(row).status).toBe(IssueStatus.Todo)
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
        managed: true,
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
    expect(restored.worktree?.provisionedBy.repoRoot).toBe(
      original.worktree!.provisionedBy.repoRoot
    )
    expect(restored.worktree?.managed).toBe(original.worktree!.managed)
    expect(restored.sessions[0].config).toEqual(original.sessions[0].config)
    expect(restored.sessions[0].title).toBe(original.sessions[0].title)
    // Live state is intentionally NOT round-tripped.
    expect(restored.sessions[0].lifecycle).toBe(SessionLifecycle.Created)
  })
})
