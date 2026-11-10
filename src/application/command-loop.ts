/**
 * The single-writer command loop (DESIGN §6.6). EVERY domain mutation is a
 * `Command` dispatched here; the loop serializes them onto one FIFO promise chain
 * so no two mutations ever interleave on the `Workspace` aggregate. Adapters do
 * their I/O asynchronously inside a handler and feed results back as events — but
 * the mutation itself is never concurrent, so aggregates need no locks and tests
 * are deterministic (§6.6 "single-writer domain").
 *
 * The loop owns ONLY sequencing + error translation. Each command's behavior
 * lives in a use-case (`use-cases/*.ts`); the loop dispatches to them. Domain
 * errors (`IllegalTransitionError`, `InvariantViolationError`) are caught here
 * and turned into a `CommandResult` — they never escape to the IPC layer as
 * exceptions (§7).
 *
 * `writeToPty`/`resizePty` are the exception to "mutation": they touch a live
 * runtime, not the aggregate. They still go through the queue so ordering
 * relative to close/create is preserved (you can't write to a disposed runtime).
 */

import type { Command, CommandResult } from './commands'
import type { AppDependencies } from './dependencies'
import { DomainError } from '../domain/errors'
import { createTask } from './use-cases/create-task'
import { deleteTask } from './use-cases/delete-task'
import { switchTask } from './use-cases/switch-task'
import { startTaskSessions } from './use-cases/start-task-sessions'
import { renameTask } from './use-cases/rename-task'
import { reorderTask } from './use-cases/reorder-task'
import { openSession } from './use-cases/open-session'
import { switchSession } from './use-cases/switch-session'
import { focusSession } from './use-cases/focus-session'
import { closeSession } from './use-cases/close-session'
import { renameSession } from './use-cases/rename-session'
import { reorderSession } from './use-cases/reorder-session'
import { joinGroup } from './use-cases/join-group'
import { leaveGroup } from './use-cases/leave-group'
import { ungroup } from './use-cases/ungroup'
import { reorderGroup } from './use-cases/reorder-group'
import { resizeGroup } from './use-cases/resize-group'
import { writeToPty, resizePty } from './use-cases/pty-io'
import { updateSettings } from './use-cases/update-settings'
import { handleRuntimeExit } from './use-cases/handle-runtime-exit'
import { ingestSessionState } from './use-cases/ingest-session-state'
import { refreshSessionState } from './use-cases/refresh-session-state'
import { createWindow } from './use-cases/create-window'
import { closeWindow } from './use-cases/close-window'
import { moveSessionToWindow } from './use-cases/move-session-to-window'
import { createWindowWithSession } from './use-cases/create-window-with-session'
import { createView } from './use-cases/create-view'
import { closeView } from './use-cases/close-view'
import { windowGroupRoot } from './use-cases/window-groups'
import { locateSession } from './use-cases/locate-session'
import { addProject } from './use-cases/add-project'
import { removeProject } from './use-cases/remove-project'
import { setProjectDefaultBranch } from './use-cases/set-project-default-branch'
import { seedProjects } from './use-cases/seed-projects'
import { createIssue } from './use-cases/create-issue'
import { updateIssue } from './use-cases/update-issue'
import { deleteIssue } from './use-cases/delete-issue'
import { bindIssue } from './use-cases/bind-issue'
import { unbindIssue } from './use-cases/unbind-issue'
import { importJiraIssues } from './use-cases/import-jira-issues'

const OK: CommandResult = { ok: true }

export class CommandLoop {
  private readonly deps: AppDependencies
  /** The FIFO tail: each dispatch chains onto this, guaranteeing serialization. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(deps: AppDependencies) {
    this.deps = deps
  }

  /**
   * Enqueue a command. Resolves with its `CommandResult` once every previously
   * queued command has settled and this one has run. Never rejects: a domain
   * error becomes `{ ok: false, error }`, so the IPC layer always gets an ack.
   */
  dispatch(command: Command): Promise<CommandResult> {
    const run = this.tail.then(
      () => this.execute(command),
      // A prior command threw an unexpected (non-domain) error; don't let it
      // poison the chain — subsequent commands still run.
      () => this.execute(command)
    )
    // Keep the chain alive regardless of this command's outcome.
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async execute(command: Command): Promise<CommandResult> {
    try {
      return await this.handle(command)
    } catch (err) {
      if (err instanceof DomainError) {
        return { ok: false, error: err.message }
      }
      // Unexpected error: surface the message but keep the app alive.
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }

  private async handle(command: Command): Promise<CommandResult> {
    // `command.input` is narrowed by `command.kind` (discriminated union), so no
    // casts are needed.
    switch (command.kind) {
      case 'createTask':
        return createTask(this.deps, command.input)
      case 'deleteTask':
        return deleteTask(this.deps, command.input)
      case 'switchTask':
        await switchTask(this.deps, command.input)
        return OK
      case 'startTaskSessions':
        await startTaskSessions(this.deps, command.input.taskId)
        return OK
      case 'renameTask':
        renameTask(this.deps, command.input)
        return OK
      case 'reorderTask':
        reorderTask(this.deps, command.input)
        return OK
      case 'createSession':
        return { ok: true, sessionId: await openSession(this.deps, command.input) }
      case 'closeSession':
        await closeSession(this.deps, command.input)
        return OK
      case 'switchSession':
        switchSession(this.deps, command.input)
        return OK
      case 'focusSession':
        // Persist-only "last focused session" write (I10); no event, no raise.
        focusSession(this.deps, command.input)
        return OK
      case 'renameSession':
        renameSession(this.deps, command.input)
        return OK
      case 'reorderSession':
        reorderSession(this.deps, command.input)
        return OK
      case 'joinGroup':
        joinGroup(this.deps, command.input)
        return OK
      case 'leaveGroup':
        leaveGroup(this.deps, command.input)
        return OK
      case 'ungroup':
        ungroup(this.deps, command.input)
        return OK
      case 'reorderGroup':
        reorderGroup(this.deps, command.input)
        return OK
      case 'resizeGroup':
        resizeGroup(this.deps, command.input)
        return OK
      case 'writeToPty':
        writeToPty(this.deps, command.input)
        return OK
      case 'resizePty':
        resizePty(this.deps, command.input)
        return OK
      case 'updateSettings':
        updateSettings(this.deps, command.input)
        return OK
      case 'handleRuntimeExit':
        handleRuntimeExit(this.deps, command.input)
        return OK
      case 'ingestSessionState':
        // A runtime state signal (§9.6); recomputes TaskState + emits the events.
        ingestSessionState(this.deps, command.input)
        return OK
      case 'refreshSessionState':
        // Manual re-evaluation (§5.4 R1); nudges the runtime's evaluator, no-op if none.
        refreshSessionState(this.deps, command.input)
        return OK
      case 'createWindow':
        return { ok: true, windowId: createWindow(this.deps, command.input) }
      case 'closeWindow': {
        // A VIEW's own close needs the richer `closeView` teardown (its
        // secondaries close first, then its sessions return to main, then main
        // auto-switches) — routed HERE, not inside `close-window.ts`, so that use
        // case and `close-view.ts` don't import each other (see `close-window.ts`
        // header). A stray `closeWindow` dispatch against a view (renderer bug,
        // stale id) still gets the correct teardown rather than the plain one.
        const windows = this.deps.persistence.loadWindows()
        const record = windows.find((w) => w.id === command.input.windowId)
        if (record?.role === 'view') {
          return closeView(this.deps, { windowId: command.input.windowId })
        }
        await closeWindow(this.deps, command.input)
        return OK
      }
      case 'moveSessionToWindow': {
        // Cross-group guard (window-view feature): a USER-initiated move (drag)
        // dispatched here must stay inside one window group — no dragging a tab
        // between a view and main, or between two views. Internal callers
        // (`createView`, `closeView`, `createWindowWithSession`, `closeWindow`'s
        // move-to-main) call `moveSessionToWindow` directly, bypassing this loop
        // entirely, so this guard never applies to them.
        const located = locateSession(this.deps.workspace, command.input.sessionId)
        if (!located) {
          return { ok: false, error: `session ${command.input.sessionId} not found` }
        }
        const windows = this.deps.persistence.loadWindows()
        const fromRoot = windowGroupRoot(windows, located.session.windowId)
        const toRoot = windowGroupRoot(windows, command.input.targetWindowId)
        if (fromRoot !== toRoot) {
          return {
            ok: false,
            error: `session ${command.input.sessionId} cannot move across window groups`
          }
        }
        moveSessionToWindow(this.deps, command.input)
        return OK
      }
      case 'createWindowWithSession':
        return { ok: true, windowId: createWindowWithSession(this.deps, command.input) }
      case 'createView':
        return createView(this.deps, command.input)
      case 'closeView':
        return closeView(this.deps, command.input)
      case 'addProject':
        return addProject(this.deps, command.input)
      case 'removeProject':
        return removeProject(this.deps, command.input)
      case 'setProjectDefaultBranch':
        return setProjectDefaultBranch(this.deps, command.input)
      case 'seedProjects':
        // Fire-and-forget from the composition root's perspective, but still
        // serialized through this loop (§6.3) so it can't race `addProject`/
        // `removeProject` mutating the same `settings.json` key.
        await seedProjects(this.deps)
        return OK
      case 'createIssue':
        return createIssue(this.deps, command.input)
      case 'updateIssue':
        return updateIssue(this.deps, command.input)
      case 'deleteIssue':
        return deleteIssue(this.deps, command.input)
      case 'bindIssue':
        return bindIssue(this.deps, command.input)
      case 'unbindIssue':
        return unbindIssue(this.deps, command.input)
      case 'importJiraIssues':
        return importJiraIssues(this.deps, command.input)
      default: {
        // Exhaustiveness: a new command kind must be handled here.
        const _never: never = command
        return { ok: false, error: `unknown command: ${JSON.stringify(_never)}` }
      }
    }
  }
}
