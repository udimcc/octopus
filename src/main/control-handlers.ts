/**
 * Method dispatcher for the octopus-cli control socket (`ControlHandler`, see
 * `shared/control-protocol.ts`). Sits in `main` (the only layer allowed to join the
 * socket transport, the command loop and the read models). The transport hands it an
 * already-parsed, version-checked request; it maps each method onto a loop command or a
 * read of the workspace snapshot and ALWAYS resolves with a reply carrying the request id.
 *
 * Read paths go through the injected `getSnapshot`/`listProjects`; every mutation goes
 * through the single-writer loop (`dispatch`), exactly like the IPC handlers. Error
 * messages are generic or come from the command's own `error`; nothing secret is echoed.
 */

import {
  checkLaunchCommand,
  checkSessionName,
  controlError,
  ControlErrorCode,
  type ControlHandler,
  type ControlIssue,
  type ControlIssueStatus,
  type ControlIssueSummary,
  type ControlReply,
  type ControlRequest,
  type ControlTask,
  type IssuesAddParams,
  type IssuesGetParams,
  type IssuesListParams,
  type SessionOpenParams,
  type TaskCreateParams,
  type TaskListParams
} from '../shared/control-protocol'
import type { Command, CommandResult } from '../application/commands'
import type { ProjectListItem } from '../application/queries/list-projects'
import type { WorkspaceSnapshot } from '../domain/snapshots'
import { canonProjectPath } from '../domain/project-path'
import { TaskLifecycle } from '../domain/lifecycle'
import { parseCreateIssueInput } from './command-validation'

/** Everything the dispatcher needs; wired in the composition root. */
export interface ControlHandlerDeps {
  /** Single-writer command loop entry (`CommandLoop.dispatch`). */
  readonly dispatch: (command: Command) => Promise<CommandResult>
  /** Current configured projects (`listProjects(deps)`). */
  readonly listProjects: () => readonly ProjectListItem[]
  /** Current workspace snapshot (`deps.workspace.toSnapshot(deps.aggregator)`). */
  readonly getSnapshot: () => WorkspaceSnapshot
}

/** Last path segment, tolerating trailing slashes. A project's display/lookup name. */
function projectName(path: string): string {
  const parts = canonProjectPath(path).split('/')
  return parts[parts.length - 1] || path
}

function ok(id: string, result: unknown): ControlReply {
  return { id, ok: true, result } as ControlReply
}

/** Build the `ControlHandler`. The returned function never rejects. */
export function createControlHandlers(deps: ControlHandlerDeps): ControlHandler {
  type Lookup = { project: ProjectListItem } | { error: ControlReply }

  const byName = (id: string, name: string): Lookup => {
    const matches = deps.listProjects().filter((p) => projectName(p.path) === name)
    if (matches.length === 0) {
      return { error: controlError(id, ControlErrorCode.NotFound, `unknown project "${name}"`) }
    }
    if (matches.length > 1) {
      return {
        error: controlError(
          id,
          ControlErrorCode.BadRequest,
          `project name "${name}" is ambiguous; use the full path: ${matches.map((m) => m.path).join(', ')}`
        )
      }
    }
    return { project: matches[0] }
  }

  /** Path first, then name (protocol doc for `issues.add`/`issues.list`). */
  const findProject = (id: string, ref: string): Lookup => {
    const canon = canonProjectPath(ref)
    const exact = deps.listProjects().find((p) => canonProjectPath(p.path) === canon)
    return exact ? { project: exact } : byName(id, ref)
  }

  const taskCreate = async (id: string, p: TaskCreateParams): Promise<ControlReply> => {
    const found = byName(id, p.project)
    if ('error' in found) return found.error
    const project = found.project
    const sourceBranch = p.sourceBranch ?? project.defaultBranch
    if (sourceBranch === undefined || sourceBranch === '') {
      return controlError(
        id,
        ControlErrorCode.BadRequest,
        'project has no default branch; pass --source-branch'
      )
    }
    const result = await deps.dispatch({
      kind: 'createTask',
      input: {
        mode: 'new',
        name: p.name || p.branch,
        repoDir: project.path,
        sourceBranch,
        newBranch: p.branch,
        background: true
      }
    })
    if (!result.ok || result.taskId === undefined) {
      return controlError(
        id,
        ControlErrorCode.CommandFailed,
        result.error ?? 'task creation failed'
      )
    }
    return ok(id, { taskId: result.taskId })
  }

  const taskList = (id: string, p: TaskListParams): ControlReply => {
    const projects = deps.listProjects()
    const snapshot = deps.getSnapshot()
    const issues = snapshot.issues ?? []
    const tasks: ControlTask[] = []
    for (const t of snapshot.tasks) {
      const repoRoot = t.worktree?.provisionedBy.repoRoot
      const match =
        repoRoot === undefined || repoRoot === ''
          ? undefined
          : projects.find((pr) => canonProjectPath(pr.path) === canonProjectPath(repoRoot))
      const project = match ? projectName(match.path) : ''
      if (p.project !== undefined && p.project !== project) continue
      const bound = issues.find((i) => i.taskId === t.id)
      tasks.push({
        id: t.id,
        name: t.name,
        project,
        branch: t.worktree?.branch ?? '',
        state: t.lifecycle,
        ...(t.worktree ? { worktreePath: t.worktree.path } : {}),
        ...(bound ? { issueId: bound.id } : {})
      })
    }
    return ok(id, { tasks })
  }

  const sessionOpen = async (id: string, p: SessionOpenParams): Promise<ControlReply> => {
    const task = deps.getSnapshot().tasks.find((t) => t.id === p.taskId)
    if (!task) {
      return controlError(id, ControlErrorCode.NotFound, `unknown task "${p.taskId}"`)
    }
    if (task.lifecycle !== TaskLifecycle.Ready) {
      return controlError(
        id,
        ControlErrorCode.NotReady,
        `task is not ready (status: ${task.lifecycle})`
      )
    }
    if (p.command !== undefined) {
      const bad = checkLaunchCommand(p.command)
      if (bad !== undefined) return controlError(id, ControlErrorCode.BadRequest, bad)
    }
    if (p.name !== undefined) {
      const bad = checkSessionName(p.name)
      if (bad !== undefined) return controlError(id, ControlErrorCode.BadRequest, bad)
    }
    // One-shot: travels as `launchCommand`, never persisted in SessionConfig. The caller
    // owns quoting; the line is typed into the user's interactive $SHELL.
    const result = await deps.dispatch({
      kind: 'createSession',
      input: {
        taskId: task.id,
        background: true,
        launchCommand: p.command,
        ...(p.name !== undefined ? { title: p.name.trim() } : {})
      }
    })
    if (!result.ok || result.sessionId === undefined) {
      return controlError(
        id,
        ControlErrorCode.CommandFailed,
        result.error ?? 'session creation failed'
      )
    }
    return ok(id, { sessionId: result.sessionId })
  }

  const toSummary = (i: NonNullable<WorkspaceSnapshot['issues']>[number]): ControlIssueSummary => ({
    id: i.id,
    name: i.name,
    status: i.status as ControlIssueStatus,
    ...(i.projectPath !== undefined ? { project: i.projectPath } : {}),
    ...(i.taskId !== undefined ? { taskId: i.taskId } : {})
  })

  const issuesList = (id: string, p: IssuesListParams): ControlReply => {
    let projectPath: string | undefined
    if (p.project !== undefined) {
      const found = findProject(id, p.project)
      if ('error' in found) return found.error
      projectPath = canonProjectPath(found.project.path)
    }
    const issues = (deps.getSnapshot().issues ?? [])
      .filter(
        (i) =>
          (p.status === undefined || i.status === p.status) &&
          (projectPath === undefined ||
            (i.projectPath !== undefined && canonProjectPath(i.projectPath) === projectPath))
      )
      .map(toSummary)
    return ok(id, { issues })
  }

  const issuesGet = (id: string, p: IssuesGetParams): ControlReply => {
    const issue = (deps.getSnapshot().issues ?? []).find((i) => i.id === p.issueId)
    if (!issue) {
      return controlError(id, ControlErrorCode.NotFound, `unknown issue "${p.issueId}"`)
    }
    const full: ControlIssue = {
      ...toSummary(issue),
      description: issue.description,
      ...(issue.blockedReasons ? { blockedReasons: issue.blockedReasons } : {})
    }
    return ok(id, { issue: full })
  }

  const issuesAdd = async (id: string, p: IssuesAddParams): Promise<ControlReply> => {
    let projectPath: string | undefined
    if (p.project !== undefined) {
      const found = findProject(id, p.project)
      if ('error' in found) return found.error
      projectPath = found.project.path
    }
    const parsed = parseCreateIssueInput({
      name: p.name,
      description: p.description,
      projectPath,
      status: p.status
    })
    if (parsed.error !== undefined) {
      return controlError(id, ControlErrorCode.BadRequest, parsed.error)
    }
    const result = await deps.dispatch({ kind: 'createIssue', input: parsed.input })
    if (!result.ok || result.issueId === undefined) {
      return controlError(
        id,
        ControlErrorCode.CommandFailed,
        result.error ?? 'issue creation failed'
      )
    }
    return ok(id, { issueId: result.issueId })
  }

  return async (request: ControlRequest): Promise<ControlReply> => {
    const id = request.id
    try {
      switch (request.method) {
        case 'projects.list':
          return ok(id, {
            projects: deps.listProjects().map((p) => ({
              name: projectName(p.path),
              path: p.path,
              ...(p.defaultBranch !== undefined ? { defaultBranch: p.defaultBranch } : {})
            }))
          })
        case 'task.create':
          return await taskCreate(id, request.params as TaskCreateParams)
        case 'task.list':
          return taskList(id, request.params as TaskListParams)
        case 'session.open':
          return await sessionOpen(id, request.params as SessionOpenParams)
        case 'issues.list':
          return issuesList(id, request.params as IssuesListParams)
        case 'issues.get':
          return issuesGet(id, request.params as IssuesGetParams)
        case 'issues.add':
          return await issuesAdd(id, request.params as IssuesAddParams)
        default:
          return controlError(id, ControlErrorCode.UnknownMethod, 'unknown method')
      }
    } catch {
      return controlError(id, ControlErrorCode.Internal, 'internal error')
    }
  }
}
