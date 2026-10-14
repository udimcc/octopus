import { describe, it, expect } from 'vitest'
import {
  toWorktreeRefDTO,
  toSessionDTO,
  toTaskDTO,
  toIssueDTO,
  toSettingsDTO,
  toWorkspaceStateDTO,
  toEventDTO,
  toSessionConfig
} from './dto-mappers'
import type {
  TaskSnapshot,
  SessionSnapshot,
  WorktreeRefSnapshot,
  IssueSnapshot
} from '../domain/snapshots'
import type { AppStateView } from '../application/queries/get-state'
import type { DomainEvent } from '../ports/event-bus'
import type { Settings } from '../ports/settings-store'
import type { SessionConfigDTO } from '../shared/dto'
import { SessionLifecycle, TaskLifecycle } from '../domain/lifecycle'
import { SessionState, TaskState } from '../domain/state'
import { IssueStatus } from '../domain/issue'
import { asTaskId, asSessionId, asTypeId, asWindowId, asIssueId } from '../domain/ids'

const worktree: WorktreeRefSnapshot = {
  path: '/wt/t1',
  branch: 'feature/x',
  baseRef: 'main',
  managed: true,
  provisionedBy: {
    script: '/scripts/create.sh',
    args: ['My Task', 'feature/x'],
    repoRoot: '/repo',
    provisionedAt: 111
  }
}

const session: SessionSnapshot = {
  id: asSessionId('s1'),
  taskId: asTaskId('t1'),
  typeId: asTypeId('terminal'),
  title: 'Terminal 1',
  config: { kind: 'terminal', cwdOverride: '/wt/t1' },
  lifecycle: SessionLifecycle.Running,
  state: SessionState.Unknown,
  order: 0,
  createdAt: 222,
  exitedAt: undefined
}

const task: TaskSnapshot = {
  id: asTaskId('t1'),
  name: 'My Task',
  worktree,
  lifecycle: TaskLifecycle.Ready,
  state: TaskState.Unknown,
  sessions: [session],
  activeSessionId: asSessionId('s1'),
  position: 0,
  createdAt: 100
}

const issue: IssueSnapshot = {
  id: asIssueId('i1'),
  name: 'Fix the thing',
  description: 'Some *markdown*',
  projectPath: '/repo/a',
  status: IssueStatus.InProgress,
  taskId: asTaskId('t1'),
  createdAt: 300,
  updatedAt: 400
}

describe('snapshot → DTO mappers (§5.2)', () => {
  it('maps a worktree ref, copying the args array (no shared reference)', () => {
    const dto = toWorktreeRefDTO(worktree)
    expect(dto).toEqual(worktree)
    expect(dto.provisionedBy.args).not.toBe(worktree.provisionedBy.args)
  })

  it('maps a session, carrying lifecycle/state as the wire strings', () => {
    const dto = toSessionDTO(session)
    expect(dto.id).toBe('s1')
    expect(dto.lifecycle).toBe('running')
    expect(dto.state).toBe('unknown')
    expect(dto.config).toEqual({ kind: 'terminal', cwdOverride: '/wt/t1' })
  })

  it('maps a task with its worktree and nested sessions', () => {
    const dto = toTaskDTO(task)
    expect(dto.id).toBe('t1')
    expect(dto.lifecycle).toBe('ready')
    expect(dto.worktree?.path).toBe('/wt/t1')
    expect(dto.sessions).toHaveLength(1)
    expect(dto.sessions[0].id).toBe('s1')
    expect(dto.activeSessionId).toBe('s1')
  })

  it('omits an absent worktree (Provisioning/Failed task)', () => {
    const dto = toTaskDTO({ ...task, worktree: undefined, lifecycle: TaskLifecycle.Provisioning })
    expect(dto.worktree).toBeUndefined()
  })

  it('maps an issue, carrying its status as the wire string ("Issues", §13.4)', () => {
    const dto = toIssueDTO(issue)
    expect(dto).toEqual({
      id: 'i1',
      name: 'Fix the thing',
      description: 'Some *markdown*',
      projectPath: '/repo/a',
      status: 'in_progress',
      taskId: 't1',
      createdAt: 300,
      updatedAt: 400
    })
  })

  it('maps an unbound, project-less issue, leaving projectPath/taskId undefined', () => {
    const dto = toIssueDTO({ ...issue, projectPath: undefined, taskId: undefined })
    expect(dto.projectPath).toBeUndefined()
    expect(dto.taskId).toBeUndefined()
  })

  it('maps settings, including issuesKey', () => {
    const settings: Settings = {
      worktree: { location: '/home/u/octopus_repos' },
      terminal: { shell: '/bin/zsh', stateDetection: false, statusChangeNotifications: false },
      defaultSessionTypeId: 'terminal',
      worktreeCreateTimeoutMs: 45000,
      groupTasksByRepo: false,
      sessionNextKey: 'ArrowUp',
      sessionPrevKey: 'ArrowDown',
      copyKey: 'Ctrl+Shift+KeyC',
      pasteKey: 'Ctrl+Shift+KeyV',
      issuesKey: 'Alt+Shift+KeyI'
    }
    expect(toSettingsDTO(settings)).toEqual({
      worktree: { location: '/home/u/octopus_repos' },
      terminal: { shell: '/bin/zsh', stateDetection: false, statusChangeNotifications: false },
      defaultSessionTypeId: 'terminal',
      worktreeCreateTimeoutMs: 45000,
      groupTasksByRepo: false,
      sessionNextKey: 'ArrowUp',
      sessionPrevKey: 'ArrowDown',
      copyKey: 'Ctrl+Shift+KeyC',
      pasteKey: 'Ctrl+Shift+KeyV',
      issuesKey: 'Alt+Shift+KeyI'
    })
  })

  it('assembles the full workspace state DTO, including issues', () => {
    const view: AppStateView = {
      workspace: { tasks: [task], activeTaskId: asTaskId('t1'), issues: [issue] },
      sessionTypes: [
        {
          typeId: 'terminal',
          displayName: 'Terminal',
          icon: 'terminal',
          availableFromVersion: 1,
          configSchema: { type: 'object' }
        }
      ],
      settings: {
        worktree: { location: '/home/u/octopus_repos' },
        terminal: {},
        defaultSessionTypeId: 'terminal',
        groupTasksByRepo: true
      },
      version: 1,
      windows: []
    }
    const dto = toWorkspaceStateDTO(view)
    expect(dto.tasks).toHaveLength(1)
    expect(dto.activeTaskId).toBe('t1')
    expect(dto.sessionTypes[0].typeId).toBe('terminal')
    expect(dto.version).toBe(1)
    expect(dto.issues).toHaveLength(1)
    expect(dto.issues[0]).toEqual({
      id: 'i1',
      name: 'Fix the thing',
      description: 'Some *markdown*',
      projectPath: '/repo/a',
      status: 'in_progress',
      taskId: 't1',
      createdAt: 300,
      updatedAt: 400
    })
  })

  it('defaults issues to an empty array when the workspace snapshot omits it', () => {
    const view: AppStateView = {
      workspace: { tasks: [task], activeTaskId: asTaskId('t1') },
      sessionTypes: [],
      settings: {
        worktree: { location: '/home/u/octopus_repos' },
        terminal: {},
        defaultSessionTypeId: 'terminal',
        groupTasksByRepo: true
      },
      version: 1,
      windows: []
    }
    expect(toWorkspaceStateDTO(view).issues).toEqual([])
  })
})

describe('toSessionConfig (inbound, §6.5)', () => {
  it('passes a terminal config through structurally', () => {
    const dto: SessionConfigDTO = { kind: 'terminal', shell: '/bin/bash' }
    expect(toSessionConfig(dto)).toEqual({ kind: 'terminal', shell: '/bin/bash' })
  })
})

describe('toEventDTO (§6.5) — total over the DomainEvent union', () => {
  // One representative of every DomainEvent variant. If a new event is added to
  // the union, this list (and toEventDTO's exhaustive switch) must grow — the
  // never-guard makes an unmapped event a build error, and this test asserts the
  // wire shape of each mapped one.
  const cases: Array<{ event: DomainEvent; expect: (dto: ReturnType<typeof toEventDTO>) => void }> =
    [
      {
        event: { type: 'ptyData', sessionId: asSessionId('s1'), data: 'x' },
        expect: (d) => expect(d).toEqual({ type: 'ptyData', sessionId: 's1', data: 'x' })
      },
      {
        event: { type: 'sessionCreated', taskId: asTaskId('t1'), session },
        expect: (d) => {
          expect(d.type).toBe('sessionCreated')
          if (d.type === 'sessionCreated') expect(d.session.id).toBe('s1')
        }
      },
      {
        event: {
          type: 'sessionExited',
          taskId: asTaskId('t1'),
          sessionId: asSessionId('s1'),
          exitCode: 3
        },
        expect: (d) =>
          expect(d).toMatchObject({ type: 'sessionExited', sessionId: 's1', exitCode: 3 })
      },
      {
        event: { type: 'sessionClosed', taskId: asTaskId('t1'), sessionId: asSessionId('s1') },
        expect: (d) => expect(d).toEqual({ type: 'sessionClosed', taskId: 't1', sessionId: 's1' })
      },
      {
        event: {
          type: 'sessionRenamed',
          taskId: asTaskId('t1'),
          sessionId: asSessionId('s1'),
          title: 'New'
        },
        expect: (d) => expect(d).toMatchObject({ type: 'sessionRenamed', title: 'New' })
      },
      {
        event: {
          type: 'sessionReordered',
          taskId: asTaskId('t1'),
          orderedSessionIds: [asSessionId('s1'), asSessionId('s2')]
        },
        expect: (d) =>
          expect(d).toEqual({
            type: 'sessionReordered',
            taskId: 't1',
            orderedSessionIds: ['s1', 's2']
          })
      },
      {
        event: { type: 'taskCreated', task },
        expect: (d) => {
          expect(d.type).toBe('taskCreated')
          if (d.type === 'taskCreated') expect(d.task.id).toBe('t1')
        }
      },
      {
        event: { type: 'taskDeleted', taskId: asTaskId('t1') },
        expect: (d) => expect(d).toEqual({ type: 'taskDeleted', taskId: 't1' })
      },
      {
        event: { type: 'taskRenamed', taskId: asTaskId('t1'), name: 'Renamed' },
        expect: (d) => expect(d).toEqual({ type: 'taskRenamed', taskId: 't1', name: 'Renamed' })
      },
      {
        event: { type: 'taskReordered', orderedTaskIds: [asTaskId('t1'), asTaskId('t2')] },
        expect: (d) => expect(d).toEqual({ type: 'taskReordered', orderedTaskIds: ['t1', 't2'] })
      },
      {
        event: { type: 'taskStale', taskId: asTaskId('t1') },
        expect: (d) => expect(d).toEqual({ type: 'taskStale', taskId: 't1' })
      },
      {
        event: { type: 'activeTaskChanged', taskId: asTaskId('t1') },
        expect: (d) => expect(d).toEqual({ type: 'activeTaskChanged', taskId: 't1' })
      },
      {
        event: { type: 'scriptProgress', taskId: asTaskId('t1'), line: 'building' },
        expect: (d) => expect(d).toEqual({ type: 'scriptProgress', taskId: 't1', line: 'building' })
      },
      {
        event: {
          type: 'scriptError',
          taskId: asTaskId('t1'),
          script: '/c',
          exitCode: 1,
          stderr: 'boom'
        },
        expect: (d) => expect(d).toMatchObject({ type: 'scriptError', exitCode: 1, stderr: 'boom' })
      },
      {
        event: {
          type: 'error',
          message: 'oops',
          taskId: asTaskId('t1'),
          sessionId: asSessionId('s1')
        },
        expect: (d) => expect(d).toMatchObject({ type: 'error', message: 'oops' })
      },
      {
        event: {
          type: 'sessionStateChanged',
          sessionId: asSessionId('s1'),
          state: SessionState.Working
        },
        expect: (d) =>
          expect(d).toEqual({ type: 'sessionStateChanged', sessionId: 's1', state: 'working' })
      },
      {
        event: {
          type: 'sessionStateChanged',
          sessionId: asSessionId('s1'),
          state: SessionState.NeedsInput,
          meta: { layer: 3, confidence: 'authoritative', reason: 'claude_permission' }
        },
        expect: (d) =>
          expect(d).toEqual({
            type: 'sessionStateChanged',
            sessionId: 's1',
            state: 'blocked',
            layer: 3,
            confidence: 'authoritative',
            reason: 'claude_permission'
          })
      },
      {
        event: {
          type: 'sessionMovedToWindow',
          sessionId: asSessionId('s1'),
          taskId: asTaskId('t1'),
          fromWindowId: asWindowId('win-2'),
          toWindowId: asWindowId('main')
        },
        // An explicit move: no `cause` key at all on the wire.
        expect: (d) => {
          expect(d).toEqual({
            type: 'sessionMovedToWindow',
            sessionId: 's1',
            taskId: 't1',
            fromWindowId: 'win-2',
            toWindowId: 'main'
          })
          expect(d).not.toHaveProperty('cause')
        }
      },
      {
        event: {
          type: 'sessionMovedToWindow',
          sessionId: asSessionId('s1'),
          taskId: asTaskId('t1'),
          fromWindowId: asWindowId('win-2'),
          toWindowId: asWindowId('main'),
          cause: 'windowClosed'
        },
        expect: (d) =>
          expect(d).toEqual({
            type: 'sessionMovedToWindow',
            sessionId: 's1',
            taskId: 't1',
            fromWindowId: 'win-2',
            toWindowId: 'main',
            cause: 'windowClosed'
          })
      },
      {
        event: { type: 'taskStateChanged', taskId: asTaskId('t1'), state: TaskState.NeedsInput },
        expect: (d) =>
          expect(d).toEqual({ type: 'taskStateChanged', taskId: 't1', state: 'blocked' })
      },
      {
        event: { type: 'issueUpserted', issue },
        expect: (d) => {
          expect(d.type).toBe('issueUpserted')
          if (d.type === 'issueUpserted') {
            expect(d.issue).toEqual({
              id: 'i1',
              name: 'Fix the thing',
              description: 'Some *markdown*',
              projectPath: '/repo/a',
              status: 'in_progress',
              taskId: 't1',
              createdAt: 300,
              updatedAt: 400
            })
          }
        }
      },
      {
        event: { type: 'issueDeleted', issueId: asIssueId('i1') },
        expect: (d) => expect(d).toEqual({ type: 'issueDeleted', issueId: 'i1' })
      }
    ]

  it('maps every event variant to a plain-string wire DTO', () => {
    for (const c of cases) {
      c.expect(toEventDTO(c.event))
    }
  })

  it('covers 20 DomainEvent variants (guards against an unmapped addition)', () => {
    const distinct = new Set(cases.map((c) => c.event.type))
    expect(distinct.size).toBe(20)
  })
})
