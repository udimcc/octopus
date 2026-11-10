import { describe, it, expect } from 'vitest'
import {
  toWorktreeRefDTO,
  toSessionDTO,
  toTaskDTO,
  toIssueDTO,
  toSettingsDTO,
  toWorkspaceStateDTO,
  toWindowedWorkspaceStateDTO,
  toEventDTO,
  toSessionConfig,
  toJiraProjectDTO,
  toJiraSprintDTO,
  toJiraIssueRowDTO,
  toJiraErrorDTO
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
import { IssueStatus, IssueSource } from '../domain/issue'
import { asTaskId, asSessionId, asTypeId, asWindowId, asIssueId, asGroupId } from '../domain/ids'
import type { JiraIssue } from '../domain/jira-import'
import type { JiraIssuePreview } from '../application/queries/preview-jira-issues'
import { JiraSourceError } from '../ports/jira-issue-source'

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
  blockedReasons: '',
  projectPath: '/repo/a',
  status: IssueStatus.InProgress,
  taskId: asTaskId('t1'),
  createdAt: 300,
  updatedAt: 400,
  source: IssueSource.Local
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
      blockedReasons: '',
      projectPath: '/repo/a',
      status: 'in_progress',
      taskId: 't1',
      createdAt: 300,
      updatedAt: 400,
      source: 'local'
    })
  })

  it('maps a Blocked issue with its reasons', () => {
    const dto = toIssueDTO({
      ...issue,
      status: IssueStatus.Blocked,
      blockedReasons: 'waiting\n- X'
    })
    expect(dto.status).toBe('blocked')
    expect(dto.blockedReasons).toBe('waiting\n- X')
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
      issuesKey: 'Alt+Shift+KeyI',
      splitRightKey: 'Ctrl+Shift+KeyE',
      splitDownKey: 'Ctrl+Shift+KeyO',
      focusPaneLeftKey: 'Ctrl+Shift+KeyH',
      focusPaneRightKey: 'Ctrl+Shift+KeyL',
      focusPaneUpKey: 'Ctrl+Shift+KeyK',
      focusPaneDownKey: 'Ctrl+Shift+KeyJ'
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
      issuesKey: 'Alt+Shift+KeyI',
      splitRightKey: 'Ctrl+Shift+KeyE',
      splitDownKey: 'Ctrl+Shift+KeyO',
      focusPaneLeftKey: 'Ctrl+Shift+KeyH',
      focusPaneRightKey: 'Ctrl+Shift+KeyL',
      focusPaneUpKey: 'Ctrl+Shift+KeyK',
      focusPaneDownKey: 'Ctrl+Shift+KeyJ'
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
      blockedReasons: '',
      projectPath: '/repo/a',
      status: 'in_progress',
      taskId: 't1',
      createdAt: 300,
      updatedAt: 400,
      source: 'local'
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

  it('toWindowedWorkspaceStateDTO carries thisWindowId/role and the window list (§6.7)', () => {
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
    const dto = toWindowedWorkspaceStateDTO(view, 'win-2', 'secondary')
    expect(dto.thisWindowId).toBe('win-2')
    expect(dto.thisWindowRole).toBe('secondary')
    expect(dto.windows).toEqual([])
    expect(dto.initialMark).toBeUndefined()
    // Groups now travel inside each task's TaskDTO.groups (§5.7) — no
    // separate per-window splitLayouts channel.
    expect(dto).not.toHaveProperty('splitLayouts')
  })

  it('toWindowedWorkspaceStateDTO passes initialMark straight through, one-shot (§5.7, §6.7)', () => {
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
    const dto = toWindowedWorkspaceStateDTO(view, 'win-2', 'secondary', {
      taskId: 't1',
      sessionId: 's1'
    })
    expect(dto.initialMark).toEqual({ taskId: 't1', sessionId: 's1' })
  })

  it('toWindowedWorkspaceStateDTO resolves viewTaskId for a VIEW window itself (window-view feature)', () => {
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
      windows: [
        {
          id: asWindowId('view-1'),
          role: 'view',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          createdAt: 1000,
          taskId: asTaskId('t1')
        }
      ]
    }
    const dto = toWindowedWorkspaceStateDTO(view, 'view-1', 'view')
    expect(dto.viewTaskId).toBe('t1')
  })

  it("toWindowedWorkspaceStateDTO resolves viewTaskId for a VIEW'S SECONDARY to the SAME pinned task", () => {
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
      windows: [
        {
          id: asWindowId('view-1'),
          role: 'view',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          createdAt: 1000,
          taskId: asTaskId('t1')
        },
        {
          id: asWindowId('sec-1'),
          role: 'secondary',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          createdAt: 1000,
          parentWindowId: asWindowId('view-1')
        }
      ]
    }
    // `thisWindowRole` stays 'secondary' — only the pin travels, not the role.
    const dto = toWindowedWorkspaceStateDTO(view, 'sec-1', 'secondary')
    expect(dto.thisWindowRole).toBe('secondary')
    expect(dto.viewTaskId).toBe('t1')
  })

  it('toWindowedWorkspaceStateDTO leaves viewTaskId undefined for main and its own plain secondaries', () => {
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
      windows: [
        {
          id: asWindowId('main'),
          role: 'main',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          createdAt: 1000
        },
        {
          id: asWindowId('sec-1'),
          role: 'secondary',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          createdAt: 1000
        }
      ]
    }
    expect(toWindowedWorkspaceStateDTO(view, 'main', 'main').viewTaskId).toBeUndefined()
    expect(toWindowedWorkspaceStateDTO(view, 'sec-1', 'secondary').viewTaskId).toBeUndefined()
  })

  it('toTaskDTO maps a 2-member group, including the split tree and color (§5.7)', () => {
    const grouped: TaskSnapshot = {
      ...task,
      groups: [
        {
          id: asGroupId('group-1'),
          tree: {
            kind: 'split',
            dir: 'row',
            ratio: 0.5,
            a: { kind: 'leaf', sessionId: asSessionId('s1') },
            b: { kind: 'leaf', sessionId: asSessionId('s2') }
          },
          colorIndex: 2
        }
      ]
    }
    const dto = toTaskDTO(grouped)
    expect(dto.groups).toEqual([
      {
        id: 'group-1',
        colorIndex: 2,
        layout: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: 's1' },
          b: { kind: 'leaf', sessionId: 's2' }
        }
      }
    ])
  })

  it('toTaskDTO defaults groups to [] when the snapshot predates the field', () => {
    const { groups, ...withoutGroups } = { ...task, groups: undefined }
    expect(groups).toBeUndefined()
    const dto = toTaskDTO(withoutGroups as TaskSnapshot)
    expect(dto.groups).toEqual([])
  })
})

describe('toIssueDTO — Jira provenance ("Jira import")', () => {
  it('carries source/jiraKey for a Jira-sourced issue', () => {
    const jiraIssue: IssueSnapshot = {
      ...issue,
      source: IssueSource.Jira,
      jiraKey: 'PROJ-123'
    }
    const dto = toIssueDTO(jiraIssue)
    expect(dto.source).toBe('jira')
    expect(dto.jiraKey).toBe('PROJ-123')
  })

  it('leaves jiraKey undefined for a local issue', () => {
    const dto = toIssueDTO(issue)
    expect(dto.source).toBe('local')
    expect(dto.jiraKey).toBeUndefined()
  })
})

describe('toSettingsDTO — jira.lastFilters passthrough ("Jira import")', () => {
  const baseSettings: Settings = {
    worktree: { location: '/home/u/octopus_repos' },
    terminal: { shell: '/bin/zsh', stateDetection: false, statusChangeNotifications: false },
    defaultSessionTypeId: 'terminal',
    worktreeCreateTimeoutMs: 45000,
    groupTasksByRepo: false,
    sessionNextKey: 'ArrowUp',
    sessionPrevKey: 'ArrowDown',
    copyKey: 'Ctrl+Shift+KeyC',
    pasteKey: 'Ctrl+Shift+KeyV',
    issuesKey: 'Alt+Shift+KeyI',
    splitRightKey: 'Ctrl+Shift+KeyE',
    splitDownKey: 'Ctrl+Shift+KeyO',
    focusPaneLeftKey: 'Ctrl+Shift+KeyH',
    focusPaneRightKey: 'Ctrl+Shift+KeyL',
    focusPaneUpKey: 'Ctrl+Shift+KeyK',
    focusPaneDownKey: 'Ctrl+Shift+KeyJ'
  }

  it('passes jira.lastFilters through unchanged when present', () => {
    const settings: Settings = {
      ...baseSettings,
      jira: {
        lastFilters: { project: 'PROJ', days: 7, sprint: { kind: 'name', text: 'Sprint 1' } }
      }
    }
    expect(toSettingsDTO(settings).jira).toEqual({
      lastFilters: { project: 'PROJ', days: 7, sprint: { kind: 'name', text: 'Sprint 1' } }
    })
  })

  it('leaves jira undefined when settings omit it, never defaulting to {}', () => {
    expect(toSettingsDTO(baseSettings).jira).toBeUndefined()
  })
})

describe('Jira domain → wire DTO mappers ("Jira import")', () => {
  it('toJiraProjectDTO is a plain passthrough', () => {
    expect(toJiraProjectDTO({ key: 'PROJ', ticketCount: 12 })).toEqual({
      key: 'PROJ',
      ticketCount: 12
    })
  })

  it('toJiraSprintDTO is a plain passthrough', () => {
    expect(toJiraSprintDTO({ id: 5, name: 'Sprint 5', state: 'active' })).toEqual({
      id: 5,
      name: 'Sprint 5',
      state: 'active'
    })
  })

  const jiraIssue: JiraIssue = {
    key: 'PROJ-1',
    summary: 'Fix the thing',
    descriptionMarkdown: 'desc',
    dodMarkdown: 'dod',
    status: 'In Progress',
    priority: 'High',
    type: 'Bug',
    assignee: 'alice',
    reporter: 'bob',
    created: '2026-01-01T00:00:00.000Z',
    projectKey: 'PROJ',
    sprints: [{ id: 1, name: 'Sprint 1', state: 'active' }]
  }

  function previewWith(classification: JiraIssuePreview['classification']): JiraIssuePreview {
    return {
      issue: jiraIssue,
      composed: { name: 'PROJ-1: Fix the thing', description: 'desc' },
      classification
    }
  }

  it('toJiraIssueRowDTO maps the raw fetched fields and a "new" classification', () => {
    const dto = toJiraIssueRowDTO(previewWith({ kind: 'new' }))
    expect(dto).toEqual({
      key: 'PROJ-1',
      summary: 'Fix the thing',
      status: 'In Progress',
      priority: 'High',
      type: 'Bug',
      assignee: 'alice',
      reporter: 'bob',
      created: '2026-01-01T00:00:00.000Z',
      sprintNames: ['Sprint 1'],
      descriptionMarkdown: 'desc',
      dodMarkdown: 'dod',
      classification: { kind: 'new' }
    })
  })

  it('toJiraIssueRowDTO maps a "duplicate" classification, carrying issueId/issueName', () => {
    const dto = toJiraIssueRowDTO(
      previewWith({ kind: 'duplicate', issueId: asIssueId('i1'), issueName: 'Fix the thing' })
    )
    expect(dto.classification).toEqual({
      kind: 'duplicate',
      issueId: 'i1',
      issueName: 'Fix the thing'
    })
  })

  it('toJiraIssueRowDTO maps a "conflict" classification, carrying issueId/issueName', () => {
    const dto = toJiraIssueRowDTO(
      previewWith({ kind: 'conflict', issueId: asIssueId('i1'), issueName: 'Different name' })
    )
    expect(dto.classification).toEqual({
      kind: 'conflict',
      issueId: 'i1',
      issueName: 'Different name'
    })
  })
})

describe('toJiraErrorDTO ("Jira import")', () => {
  it('maps a JiraSourceError, carrying its kind and message', () => {
    const err = new JiraSourceError('unauthorized', 'bad credentials')
    expect(toJiraErrorDTO(err)).toEqual({ kind: 'unauthorized', message: 'bad credentials' })
  })

  it.each(['noKey', 'unauthorized', 'unreachable', 'gateway'] as const)(
    'preserves the %s kind from a JiraSourceError',
    (kind) => {
      const err = new JiraSourceError(kind, 'x')
      expect(toJiraErrorDTO(err).kind).toBe(kind)
    }
  )

  it('caps an overlong JiraSourceError message, appending an ellipsis', () => {
    const long = 'x'.repeat(400)
    const err = new JiraSourceError('gateway', long)
    const dto = toJiraErrorDTO(err)
    expect(dto.message.length).toBe(301) // 300 chars + '…'
    expect(dto.message.endsWith('…')).toBe(true)
  })

  it('trims a JiraSourceError message before capping', () => {
    const err = new JiraSourceError('gateway', '  padded  ')
    expect(toJiraErrorDTO(err).message).toBe('padded')
  })

  it('maps a plain Error (not a JiraSourceError) to a fixed, generic gateway message', () => {
    const dto = toJiraErrorDTO(new Error('some internal stack trace detail'))
    expect(dto).toEqual({
      kind: 'gateway',
      message: 'an unexpected error occurred contacting the Jira gateway'
    })
  })

  it('maps a non-Error throw (e.g. a thrown string) the same way, never echoing it', () => {
    const dto = toJiraErrorDTO('a raw thrown string, not an Error')
    expect(dto).toEqual({
      kind: 'gateway',
      message: 'an unexpected error occurred contacting the Jira gateway'
    })
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
        event: {
          type: 'groupsChanged',
          taskId: asTaskId('t1'),
          groups: [
            {
              id: asGroupId('group-1'),
              tree: {
                kind: 'split',
                dir: 'row',
                ratio: 0.5,
                a: { kind: 'leaf', sessionId: asSessionId('s1') },
                b: { kind: 'leaf', sessionId: asSessionId('s2') }
              },
              colorIndex: 0
            }
          ]
        },
        expect: (d) => {
          expect(d.type).toBe('groupsChanged')
          if (d.type === 'groupsChanged') {
            expect(d.taskId).toBe('t1')
            expect(d.groups).toEqual([
              {
                id: 'group-1',
                colorIndex: 0,
                layout: {
                  kind: 'split',
                  dir: 'row',
                  ratio: 0.5,
                  a: { kind: 'leaf', sessionId: 's1' },
                  b: { kind: 'leaf', sessionId: 's2' }
                }
              }
            ])
          }
        }
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
              blockedReasons: '',
              projectPath: '/repo/a',
              status: 'in_progress',
              taskId: 't1',
              createdAt: 300,
              updatedAt: 400,
              source: 'local'
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

  it('covers 21 DomainEvent variants (guards against an unmapped addition)', () => {
    const distinct = new Set(cases.map((c) => c.event.type))
    expect(distinct.size).toBe(21)
  })
})

describe('toEventDTO background flag (control-socket originated events)', () => {
  const bgEvents: Array<{ name: string; make: (background?: boolean) => DomainEvent }> = [
    {
      name: 'taskCreated',
      make: (background) => ({
        type: 'taskCreated',
        task,
        ...(background === undefined ? {} : { background })
      })
    },
    {
      name: 'sessionCreated',
      make: (background) => ({
        type: 'sessionCreated',
        taskId: asTaskId('t1'),
        session,
        ...(background === undefined ? {} : { background })
      })
    },
    {
      name: 'scriptProgress',
      make: (background) => ({
        type: 'scriptProgress',
        taskId: asTaskId('t1'),
        line: 'l',
        ...(background === undefined ? {} : { background })
      })
    },
    {
      name: 'scriptError',
      make: (background) => ({
        type: 'scriptError',
        taskId: asTaskId('t1'),
        script: '/c',
        exitCode: 1,
        stderr: 'boom',
        ...(background === undefined ? {} : { background })
      })
    },
    {
      name: 'error',
      make: (background) => ({
        type: 'error',
        message: 'oops',
        taskId: asTaskId('t1'),
        ...(background === undefined ? {} : { background })
      })
    }
  ]

  it.each(bgEvents)('$name passes background: true through to the DTO', ({ make }) => {
    expect(toEventDTO(make(true))).toHaveProperty('background', true)
  })

  it.each(bgEvents)('$name omits the background key when unset or false', ({ make }) => {
    expect(toEventDTO(make())).not.toHaveProperty('background')
    expect(toEventDTO(make(false))).not.toHaveProperty('background')
  })
})
