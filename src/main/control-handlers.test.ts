import { describe, it, expect } from 'vitest'
import { createControlHandlers, type ControlHandlerDeps } from './control-handlers'
import {
  CONTROL_PROTOCOL_VERSION,
  ControlErrorCode,
  MAX_COMMAND_BYTES,
  MAX_SESSION_NAME_CHARS,
  type ControlMethod,
  type ControlReply
} from '../shared/control-protocol'
import type { Command, CommandResult } from '../application/commands'
import type { ProjectListItem } from '../application/queries/list-projects'
import type { TaskSnapshot, WorkspaceSnapshot, IssueSnapshot } from '../domain/snapshots'
import { asIssueId, asTaskId } from '../domain/ids'
import { TaskLifecycle } from '../domain/lifecycle'
import { TaskState } from '../domain/state'
import { IssueSource, IssueStatus } from '../domain/issue'

function projectItem(path: string, defaultBranch?: string): ProjectListItem {
  return { path, defaultBranch, taskCount: 0 }
}

function taskSnap(id: string, over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: asTaskId(id),
    name: id,
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [],
    position: 0,
    createdAt: 1,
    worktree: {
      path: `/wt/${id}`,
      branch: `br-${id}`,
      managed: true,
      provisionedBy: { script: 'git', args: [], repoRoot: '/repos/app', provisionedAt: 1 }
    },
    ...over
  } as TaskSnapshot
}

function issueSnap(id: string, over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    id: asIssueId(id),
    name: `name-${id}`,
    description: `desc-${id}`,
    blockedReasons: '',
    status: IssueStatus.Todo,
    createdAt: 1,
    updatedAt: 1,
    source: IssueSource.Local,
    ...over
  }
}

interface Rig {
  readonly handle: ReturnType<typeof createControlHandlers>
  readonly dispatched: Command[]
  readonly deps: ControlHandlerDeps
  call(method: ControlMethod, params?: Record<string, unknown>): Promise<ControlReply>
}

function rig(
  opts: {
    projects?: ProjectListItem[]
    snapshot?: WorkspaceSnapshot
    result?: CommandResult | (() => CommandResult)
    dispatchThrows?: Error
  } = {}
): Rig {
  const dispatched: Command[] = []
  const deps: ControlHandlerDeps = {
    dispatch: async (c) => {
      dispatched.push(c)
      if (opts.dispatchThrows) throw opts.dispatchThrows
      const r = opts.result ?? { ok: true }
      return typeof r === 'function' ? r() : r
    },
    listProjects: () => opts.projects ?? [],
    getSnapshot: () => opts.snapshot ?? { tasks: [], issues: [] }
  }
  const handle = createControlHandlers(deps)
  let n = 0
  return {
    handle,
    dispatched,
    deps,
    call: (method, params = {}) =>
      handle({
        id: `id-${++n}`,
        version: CONTROL_PROTOCOL_VERSION,
        method,
        params
      } as never)
  }
}

const failed = (r: ControlReply): { code: string; message: string } => {
  if (r.ok) throw new Error('expected failure')
  return r.error
}
const succeeded = (r: ControlReply): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.result as unknown as Record<string, unknown>
}

describe('projects.list', () => {
  it('maps paths to basenames (trailing slash tolerated) and omits an unset defaultBranch', async () => {
    const r = rig({ projects: [projectItem('/repos/app/', 'main'), projectItem('/repos/lib')] })
    expect(succeeded(await r.call('projects.list'))).toEqual({
      projects: [
        { name: 'app', path: '/repos/app/', defaultBranch: 'main' },
        { name: 'lib', path: '/repos/lib' }
      ]
    })
  })
})

describe('task.create', () => {
  const projects = [projectItem('/repos/app', 'main')]

  it('dispatches a background createTask and returns the taskId', async () => {
    const r = rig({ projects, result: { ok: true, taskId: asTaskId('t9') } })
    const reply = await r.call('task.create', { project: 'app', branch: 'feat/x', name: 'Nice' })
    expect(succeeded(reply)).toEqual({ taskId: 't9' })
    expect(r.dispatched).toEqual([
      {
        kind: 'createTask',
        input: {
          mode: 'new',
          name: 'Nice',
          repoDir: '/repos/app',
          sourceBranch: 'main',
          newBranch: 'feat/x',
          background: true
        }
      }
    ])
  })

  it('uses the branch as the task name when no name is given', async () => {
    const r = rig({ projects, result: { ok: true, taskId: asTaskId('t1') } })
    await r.call('task.create', { project: 'app', branch: 'feat/x' })
    expect((r.dispatched[0] as { input: { name: string } }).input.name).toBe('feat/x')
  })

  it('an explicit sourceBranch wins over the project default', async () => {
    const r = rig({ projects, result: { ok: true, taskId: asTaskId('t1') } })
    await r.call('task.create', { project: 'app', branch: 'b', sourceBranch: 'dev' })
    expect((r.dispatched[0] as { input: { sourceBranch: string } }).input.sourceBranch).toBe('dev')
  })

  it('unknown project is not_found and nothing is dispatched', async () => {
    const r = rig({ projects })
    const e = failed(await r.call('task.create', { project: 'zzz', branch: 'b' }))
    expect(e.code).toBe(ControlErrorCode.NotFound)
    expect(r.dispatched).toHaveLength(0)
  })

  it('an ambiguous project basename is bad_request naming both paths', async () => {
    const r = rig({ projects: [projectItem('/a/app', 'main'), projectItem('/b/app', 'main')] })
    const e = failed(await r.call('task.create', { project: 'app', branch: 'b' }))
    expect(e.code).toBe(ControlErrorCode.BadRequest)
    expect(e.message).toContain('/a/app')
    expect(e.message).toContain('/b/app')
    expect(r.dispatched).toHaveLength(0)
  })

  it('no default branch and no sourceBranch is bad_request', async () => {
    for (const defaultBranch of [undefined, '']) {
      const r = rig({ projects: [projectItem('/repos/app', defaultBranch)] })
      const e = failed(await r.call('task.create', { project: 'app', branch: 'b' }))
      expect(e.code).toBe(ControlErrorCode.BadRequest)
      expect(e.message).toContain('--source-branch')
      expect(r.dispatched).toHaveLength(0)
    }
  })

  it('a failed command is command_failed carrying the command error', async () => {
    const r = rig({ projects, result: { ok: false, error: 'create.sh exited 1' } })
    const e = failed(await r.call('task.create', { project: 'app', branch: 'b' }))
    expect(e).toEqual({ code: ControlErrorCode.CommandFailed, message: 'create.sh exited 1' })
  })

  it('ok without a taskId is still command_failed', async () => {
    const r = rig({ projects, result: { ok: true } })
    const e = failed(await r.call('task.create', { project: 'app', branch: 'b' }))
    expect(e.code).toBe(ControlErrorCode.CommandFailed)
  })

  it('a throwing dispatch becomes an internal error', async () => {
    const r = rig({ projects, dispatchThrows: new Error('db password=hunter2') })
    const e = failed(await r.call('task.create', { project: 'app', branch: 'b' }))
    expect(e).toEqual({ code: ControlErrorCode.Internal, message: 'internal error' })
  })
})

describe('task.list', () => {
  const projects = [projectItem('/repos/app', 'main'), projectItem('/repos/lib')]
  const snapshot: WorkspaceSnapshot = {
    tasks: [
      taskSnap('t1'),
      taskSnap('t2', {
        lifecycle: TaskLifecycle.Provisioning,
        worktree: undefined
      }),
      taskSnap('t3', {
        worktree: {
          path: '/wt/t3',
          branch: 'b3',
          managed: true,
          provisionedBy: { script: 'git', args: [], repoRoot: '/repos/lib/', provisionedAt: 1 }
        } as never
      })
    ],
    issues: [issueSnap('i1', { taskId: asTaskId('t1') })]
  }

  it('lists tasks with project, branch, state, worktreePath and bound issueId', async () => {
    const r = rig({ projects, snapshot })
    const { tasks } = succeeded(await r.call('task.list')) as { tasks: Record<string, unknown>[] }
    expect(tasks).toEqual([
      {
        id: 't1',
        name: 't1',
        project: 'app',
        branch: 'br-t1',
        state: 'ready',
        worktreePath: '/wt/t1',
        issueId: 'i1'
      },
      { id: 't2', name: 't2', project: '', branch: '', state: 'provisioning' },
      {
        id: 't3',
        name: 't3',
        project: 'lib',
        branch: 'b3',
        state: 'ready',
        worktreePath: '/wt/t3'
      }
    ])
  })

  it('filters by project name', async () => {
    const r = rig({ projects, snapshot })
    const { tasks } = succeeded(await r.call('task.list', { project: 'lib' })) as {
      tasks: { id: string }[]
    }
    expect(tasks.map((t) => t.id)).toEqual(['t3'])
  })
})

describe('session.open', () => {
  const ready: WorkspaceSnapshot = { tasks: [taskSnap('t1')] }

  it('unknown task is not_found', async () => {
    const r = rig({ snapshot: ready })
    const e = failed(await r.call('session.open', { taskId: 'nope' }))
    expect(e.code).toBe(ControlErrorCode.NotFound)
    expect(r.dispatched).toHaveLength(0)
  })

  it.each([TaskLifecycle.Provisioning, TaskLifecycle.ProvisionFailed])(
    'a %s task is not_ready',
    async (lifecycle) => {
      const r = rig({ snapshot: { tasks: [taskSnap('t1', { lifecycle })] } })
      const e = failed(await r.call('session.open', { taskId: 't1' }))
      expect(e.code).toBe(ControlErrorCode.NotReady)
      expect(e.message).toContain(lifecycle)
      expect(r.dispatched).toHaveLength(0)
    }
  )

  it('without a command opens a plain background session with no launch command', async () => {
    const r = rig({ snapshot: ready, result: { ok: true, sessionId: 's1' as never } })
    expect(succeeded(await r.call('session.open', { taskId: 't1' }))).toEqual({ sessionId: 's1' })
    expect(r.dispatched).toEqual([
      { kind: 'createSession', input: { taskId: 't1', background: true, launchCommand: undefined } }
    ])
  })

  it('passes the command through unchanged as the one-shot launchCommand', async () => {
    const r = rig({ snapshot: ready, result: { ok: true, sessionId: 's1' as never } })
    const command = `claude -- "$(cat /tmp/x; rm -f /tmp/x)"`
    await r.call('session.open', { taskId: 't1', command })
    expect(r.dispatched).toEqual([
      { kind: 'createSession', input: { taskId: 't1', background: true, launchCommand: command } }
    ])
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '  \t '],
    ['containing LF', 'echo a\necho b'],
    ['containing CR', 'echo a\rb'],
    ['containing NUL', 'echo a\0b'],
    ['over the limit', 'a'.repeat(MAX_COMMAND_BYTES + 1)],
    // 2 bytes per char: under the limit in characters, over it in bytes.
    ['multibyte over the limit in bytes', 'é'.repeat(MAX_COMMAND_BYTES / 2 + 1)]
  ])('rejects a command that is %s as bad_request without dispatching', async (_n, command) => {
    const r = rig({ snapshot: ready })
    const e = failed(await r.call('session.open', { taskId: 't1', command }))
    expect(e.code).toBe(ControlErrorCode.BadRequest)
    expect(r.dispatched).toHaveLength(0)
  })

  it.each([
    ['ASCII at the limit', 'a'.repeat(MAX_COMMAND_BYTES)],
    ['multibyte exactly at the limit', 'é'.repeat(MAX_COMMAND_BYTES / 2)]
  ])('accepts a command of %s', async (_n, command) => {
    const r = rig({ snapshot: ready, result: { ok: true, sessionId: 's1' as never } })
    expect((await r.call('session.open', { taskId: 't1', command })).ok).toBe(true)
  })

  it('a name becomes the trimmed tab title of the new session', async () => {
    const r = rig({ snapshot: ready, result: { ok: true, sessionId: 's1' as never } })
    await r.call('session.open', { taskId: 't1', name: '  Fix rejects ' })
    expect(r.dispatched).toEqual([
      {
        kind: 'createSession',
        input: { taskId: 't1', background: true, launchCommand: undefined, title: 'Fix rejects' }
      }
    ])
  })

  it.each([
    ['blank', '  '],
    ['too long', 'a'.repeat(MAX_SESSION_NAME_CHARS + 1)],
    ['multi-line', 'a\nb']
  ])('rejects a %s name as bad_request without dispatching', async (_n, name) => {
    const r = rig({ snapshot: ready })
    const e = failed(await r.call('session.open', { taskId: 't1', name }))
    expect(e.code).toBe(ControlErrorCode.BadRequest)
    expect(r.dispatched).toHaveLength(0)
  })

  it('a failed open replies command_failed', async () => {
    const r = rig({ snapshot: ready, result: { ok: false, error: 'spawn failed' } })
    const e = failed(await r.call('session.open', { taskId: 't1', command: 'ls' }))
    expect(e).toEqual({ code: ControlErrorCode.CommandFailed, message: 'spawn failed' })
  })

  it('a dispatch throw replies internal', async () => {
    const r = rig({ snapshot: ready, dispatchThrows: new Error('boom') })
    const e = failed(await r.call('session.open', { taskId: 't1', command: 'ls' }))
    expect(e.code).toBe(ControlErrorCode.Internal)
  })

  it('ok without a sessionId counts as failure', async () => {
    const r = rig({ snapshot: ready, result: { ok: true } })
    const e = failed(await r.call('session.open', { taskId: 't1', command: 'ls' }))
    expect(e.code).toBe(ControlErrorCode.CommandFailed)
  })
})

describe('issues.*', () => {
  const projects = [projectItem('/repos/app', 'main'), projectItem('/repos/lib')]
  const snapshot: WorkspaceSnapshot = {
    tasks: [],
    issues: [
      issueSnap('i1', { projectPath: '/repos/app', status: IssueStatus.Todo }),
      issueSnap('i2', {
        projectPath: '/repos/lib/',
        status: IssueStatus.Done,
        taskId: asTaskId('t1')
      }),
      issueSnap('i3', { status: IssueStatus.Todo })
    ]
  }

  it('list returns summaries (no description)', async () => {
    const r = rig({ projects, snapshot })
    const { issues } = succeeded(await r.call('issues.list')) as {
      issues: Record<string, unknown>[]
    }
    expect(issues).toHaveLength(3)
    expect(issues[1]).toEqual({
      id: 'i2',
      name: 'name-i2',
      status: 'done',
      project: '/repos/lib/',
      taskId: 't1'
    })
    expect(issues[2]).toEqual({ id: 'i3', name: 'name-i3', status: 'todo' })
  })

  it('list filters by status and by project name or path', async () => {
    const r = rig({ projects, snapshot })
    const ids = async (p: Record<string, unknown>): Promise<string[]> =>
      (succeeded(await r.call('issues.list', p)) as { issues: { id: string }[] }).issues.map(
        (i) => i.id
      )
    expect(await ids({ status: 'todo' })).toEqual(['i1', 'i3'])
    expect(await ids({ project: 'app' })).toEqual(['i1'])
    expect(await ids({ project: '/repos/lib' })).toEqual(['i2'])
    expect(await ids({ project: 'lib', status: 'done' })).toEqual(['i2'])
  })

  it('list with an unknown project is not_found', async () => {
    const r = rig({ projects, snapshot })
    expect(failed(await r.call('issues.list', { project: 'zzz' })).code).toBe(
      ControlErrorCode.NotFound
    )
  })

  it('get returns the description; unknown id is not_found', async () => {
    const r = rig({ projects, snapshot })
    const { issue } = succeeded(await r.call('issues.get', { issueId: 'i1' })) as {
      issue: Record<string, unknown>
    }
    expect(issue).toMatchObject({ id: 'i1', description: 'desc-i1', project: '/repos/app' })
    expect(failed(await r.call('issues.get', { issueId: 'nope' })).code).toBe(
      ControlErrorCode.NotFound
    )
    expect(issue).not.toHaveProperty('blockedReasons')
  })

  it('get includes blockedReasons when set, and list filters by blocked', async () => {
    const r = rig({
      projects,
      snapshot: {
        ...snapshot,
        issues: [
          issueSnap('b1', { status: IssueStatus.Blocked, blockedReasons: 'waiting on infra' })
        ]
      }
    })
    const { issue } = succeeded(await r.call('issues.get', { issueId: 'b1' })) as {
      issue: Record<string, unknown>
    }
    expect(issue).toMatchObject({ status: 'blocked', blockedReasons: 'waiting on infra' })
    const { issues } = succeeded(await r.call('issues.list', { status: 'blocked' })) as {
      issues: { id: string }[]
    }
    expect(issues.map((i) => i.id)).toEqual(['b1'])
  })

  it('add resolves a project by name and by path and dispatches createIssue', async () => {
    const r = rig({ projects, snapshot, result: { ok: true, issueId: asIssueId('new') } })
    expect(
      succeeded(
        await r.call('issues.add', { name: 'n', description: 'd', project: 'app', status: 'done' })
      )
    ).toEqual({ issueId: 'new' })
    await r.call('issues.add', { name: 'n', description: 'd', project: '/repos/lib' })
    expect(r.dispatched).toEqual([
      {
        kind: 'createIssue',
        input: { name: 'n', description: 'd', projectPath: '/repos/app', status: IssueStatus.Done }
      },
      {
        kind: 'createIssue',
        input: { name: 'n', description: 'd', projectPath: '/repos/lib', status: undefined }
      }
    ])
  })

  it('add without a project leaves projectPath undefined; unknown project is not_found', async () => {
    const r = rig({ projects, snapshot, result: { ok: true, issueId: asIssueId('new') } })
    await r.call('issues.add', { name: 'n', description: '' })
    expect(
      (r.dispatched[0] as { input: { projectPath?: string } }).input.projectPath
    ).toBeUndefined()
    expect(
      failed(await r.call('issues.add', { name: 'n', description: 'd', project: 'zzz' })).code
    ).toBe(ControlErrorCode.NotFound)
  })

  it('add reports a failed command as command_failed', async () => {
    const r = rig({ projects, result: { ok: false, error: 'db locked' } })
    expect(failed(await r.call('issues.add', { name: 'n', description: 'd' }))).toEqual({
      code: ControlErrorCode.CommandFailed,
      message: 'db locked'
    })
  })
})

describe('dispatcher', () => {
  it('never rejects, even when a dep throws synchronously, and preserves the id', async () => {
    const deps: ControlHandlerDeps = {
      dispatch: async () => ({ ok: true }),
      listProjects: () => {
        throw new Error('x')
      },
      getSnapshot: () => ({ tasks: [] })
    }
    const reply = await createControlHandlers(deps)({
      id: 'keep',
      version: 1,
      method: 'projects.list',
      params: {}
    })
    expect(reply).toMatchObject({ id: 'keep', ok: false, error: { code: 'internal' } })
  })

  it('replies unknown_method for a method the dispatcher does not implement', async () => {
    const r = rig()
    const reply = await r.handle({ id: 'x', version: 1, method: 'bogus', params: {} } as never)
    expect(failed(reply).code).toBe(ControlErrorCode.UnknownMethod)
  })
})
