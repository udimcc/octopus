/**
 * Snapshot/event → wire-DTO mappers (DESIGN §5.2, §6.5). `main` is the ONLY layer
 * that may import both `domain`/`application` and `shared` (boundary rule), so the
 * domain↔wire translation lives here — the application returns domain snapshots,
 * this maps them to the `shared` DTOs the renderer sees. The two shapes are
 * structurally aligned by design; this module is the tested seam that keeps them
 * in step (`dto-mappers.test.ts`), replacing what would otherwise be a forbidden
 * shared import.
 *
 * Enum VALUES are exactly the DTO strings (e.g. `SessionLifecycle.Running ===
 * 'running'`), so lifecycle/state/typeId assign straight across as `string`.
 *
 * Direction:
 *   - outbound (backend → renderer): `toWorkspaceStateDTO`, `toTaskDTO`,
 *     `toSessionDTO`, `toEventDTO`.
 *   - inbound (renderer → backend): the command-input mappers rebrand string ids
 *     to domain-branded ids and map `SessionConfigDTO` → domain `SessionConfig`.
 */

import type {
  WorkspaceStateDTO,
  WindowedWorkspaceStateDTO,
  WindowDTO,
  TaskDTO,
  SessionDTO,
  WorktreeRefDTO,
  SessionTypeDTO,
  SettingsDTO,
  SessionConfigDTO
} from '../shared/dto'
import type { EventDTO } from '../shared/events'
import type { TaskSnapshot, SessionSnapshot, WorktreeRefSnapshot } from '../domain/snapshots'
import type { DomainEvent } from '../ports/event-bus'
import type { Settings } from '../ports/settings-store'
import type { WindowRecord } from '../ports/workspace-persistence'
import type { AppStateView, SessionTypeView } from '../application/queries/get-state'
import type { SessionConfig } from '../domain/session-config'

// ── Outbound: domain snapshot → wire DTO ────────────────────────────────────────

export function toWorktreeRefDTO(w: WorktreeRefSnapshot): WorktreeRefDTO {
  return {
    path: w.path,
    branch: w.branch,
    baseRef: w.baseRef,
    managed: w.managed,
    provisionedBy: {
      script: w.provisionedBy.script,
      args: [...w.provisionedBy.args],
      repoRoot: w.provisionedBy.repoRoot,
      provisionedAt: w.provisionedBy.provisionedAt
    }
  }
}

export function toSessionDTO(s: SessionSnapshot): SessionDTO {
  return {
    id: s.id,
    taskId: s.taskId,
    typeId: s.typeId,
    title: s.title,
    // Config is a discriminated union structurally identical to the DTO union.
    config: s.config as SessionConfigDTO,
    lifecycle: s.lifecycle,
    state: s.state,
    order: s.order,
    createdAt: s.createdAt,
    exitedAt: s.exitedAt,
    // V1.5: which window renders the session (§3.7). `toSnapshot` always emits it.
    windowId: s.windowId ?? 'main'
  }
}

export function toTaskDTO(t: TaskSnapshot): TaskDTO {
  return {
    id: t.id,
    name: t.name,
    worktree: t.worktree ? toWorktreeRefDTO(t.worktree) : undefined,
    lifecycle: t.lifecycle,
    state: t.state,
    sessions: t.sessions.map(toSessionDTO),
    activeSessionId: t.activeSessionId,
    position: t.position,
    createdAt: t.createdAt
  }
}

function toSessionTypeDTO(v: SessionTypeView): SessionTypeDTO {
  return {
    typeId: v.typeId,
    displayName: v.displayName,
    icon: v.icon,
    availableFromVersion: v.availableFromVersion,
    configSchema: v.configSchema
  }
}

export function toSettingsDTO(s: Settings): SettingsDTO {
  return {
    worktree: { location: s.worktree.location },
    terminal: { shell: s.terminal.shell, stateDetection: s.terminal.stateDetection },
    defaultSessionTypeId: s.defaultSessionTypeId,
    worktreeCreateTimeoutMs: s.worktreeCreateTimeoutMs,
    groupTasksByRepo: s.groupTasksByRepo,
    sessionNextKey: s.sessionNextKey,
    sessionPrevKey: s.sessionPrevKey,
    taskNextKey: s.taskNextKey,
    taskPrevKey: s.taskPrevKey,
    newSessionKey: s.newSessionKey,
    newTaskKey: s.newTaskKey,
    closeSessionKey: s.closeSessionKey,
    searchKey: s.searchKey,
    copyKey: s.copyKey,
    pasteKey: s.pasteKey
  }
}

export function toWorkspaceStateDTO(view: AppStateView): WorkspaceStateDTO {
  return {
    tasks: view.workspace.tasks.map(toTaskDTO),
    activeTaskId: view.workspace.activeTaskId,
    sessionTypes: view.sessionTypes.map(toSessionTypeDTO),
    settings: toSettingsDTO(view.settings),
    version: view.version
  }
}

export function toWindowDTO(w: WindowRecord): WindowDTO {
  return {
    id: w.id,
    role: w.role,
    bounds: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height },
    createdAt: w.createdAt
  }
}

/**
 * Build the per-window hydration payload (V1.5, §5.6, §6.7): the base workspace
 * state widened with the CALLING window's identity (`thisWindowId`/role, resolved
 * by `main` from `e.sender`) and the full window list. Sessions stay unfiltered;
 * each renderer shows only those whose `windowId` matches its own.
 */
export function toWindowedWorkspaceStateDTO(
  view: AppStateView,
  thisWindowId: string,
  thisWindowRole: 'main' | 'secondary'
): WindowedWorkspaceStateDTO {
  return {
    ...toWorkspaceStateDTO(view),
    thisWindowId,
    thisWindowRole,
    windows: view.windows.map(toWindowDTO)
  }
}

/**
 * Map a `DomainEvent` to its wire `EventDTO`. Total over the union; the exhaustive
 * `never` guard fails the build if a new event is added without a mapping. The
 * dormant state events are mapped too (§10) though nobody emits them in V1.
 */
export function toEventDTO(e: DomainEvent): EventDTO {
  switch (e.type) {
    case 'ptyData':
      return { type: 'ptyData', sessionId: e.sessionId, data: e.data }
    case 'sessionCreated':
      return { type: 'sessionCreated', taskId: e.taskId, session: toSessionDTO(e.session) }
    case 'sessionExited':
      return {
        type: 'sessionExited',
        taskId: e.taskId,
        sessionId: e.sessionId,
        exitCode: e.exitCode
      }
    case 'sessionClosed':
      return { type: 'sessionClosed', taskId: e.taskId, sessionId: e.sessionId }
    case 'sessionRenamed':
      return {
        type: 'sessionRenamed',
        taskId: e.taskId,
        sessionId: e.sessionId,
        title: e.title
      }
    case 'sessionReordered':
      return {
        type: 'sessionReordered',
        taskId: e.taskId,
        orderedSessionIds: [...e.orderedSessionIds]
      }
    case 'taskCreated':
      return { type: 'taskCreated', task: toTaskDTO(e.task) }
    case 'taskDeleted':
      return { type: 'taskDeleted', taskId: e.taskId }
    case 'taskRenamed':
      return { type: 'taskRenamed', taskId: e.taskId, name: e.name }
    case 'taskReordered':
      return { type: 'taskReordered', orderedTaskIds: [...e.orderedTaskIds] }
    case 'taskStale':
      return { type: 'taskStale', taskId: e.taskId }
    case 'activeTaskChanged':
      return { type: 'activeTaskChanged', taskId: e.taskId }
    case 'activeSessionChanged':
      return {
        type: 'activeSessionChanged',
        taskId: e.taskId,
        sessionId: e.sessionId,
        windowId: e.windowId
      }
    case 'scriptProgress':
      return { type: 'scriptProgress', taskId: e.taskId, line: e.line }
    case 'scriptError':
      return {
        type: 'scriptError',
        taskId: e.taskId,
        script: e.script,
        exitCode: e.exitCode,
        stderr: e.stderr
      }
    case 'error':
      return { type: 'error', message: e.message, taskId: e.taskId, sessionId: e.sessionId }
    case 'windowCreated':
      return {
        type: 'windowCreated',
        windowId: e.windowId,
        role: e.role,
        bounds: { x: e.bounds.x, y: e.bounds.y, width: e.bounds.width, height: e.bounds.height }
      }
    case 'windowClosed':
      return { type: 'windowClosed', windowId: e.windowId }
    case 'sessionMovedToWindow':
      return {
        type: 'sessionMovedToWindow',
        sessionId: e.sessionId,
        taskId: e.taskId,
        fromWindowId: e.fromWindowId,
        toWindowId: e.toWindowId
      }
    case 'sessionStateChanged':
      return {
        type: 'sessionStateChanged',
        sessionId: e.sessionId,
        state: e.state,
        // Forward the deciding-signal metadata for the debug overlay (§11); each
        // field is independently optional (a provider may supply only some).
        layer: e.meta?.layer,
        confidence: e.meta?.confidence,
        reason: e.meta?.reason,
        subState: e.meta?.subState
      }
    case 'taskStateChanged':
      return { type: 'taskStateChanged', taskId: e.taskId, state: e.state }
    default: {
      const _never: never = e
      throw new Error(`unmapped domain event: ${JSON.stringify(_never)}`)
    }
  }
}

// ── Inbound: wire DTO → domain-branded config ───────────────────────────────────

/**
 * Map a wire `SessionConfigDTO` to the domain `SessionConfig`. Structurally
 * identical (both discriminate on `kind: 'terminal'`); the cast localizes the
 * boundary crossing so `ipc-handlers` needn't. Validated later against the type's
 * schema in `openSession` (ajv), so an ill-formed config is rejected there.
 */
export function toSessionConfig(dto: SessionConfigDTO): SessionConfig {
  return dto as SessionConfig
}
