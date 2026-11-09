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
  SessionConfigDTO,
  IssueDTO,
  GroupDTO,
  SplitNode,
  JiraProjectDTO,
  JiraSprintDTO,
  JiraIssueRowDTO,
  JiraClassificationDTO,
  JiraErrorDTO
} from '../shared/dto'
import type { EventDTO } from '../shared/events'
import type {
  TaskSnapshot,
  SessionSnapshot,
  WorktreeRefSnapshot,
  IssueSnapshot,
  GroupSnapshot
} from '../domain/snapshots'
import type { GroupTree } from '../domain/group-tree'
import type { DomainEvent } from '../ports/event-bus'
import type { Settings } from '../ports/settings-store'
import type { WindowRecord } from '../ports/workspace-persistence'
import type { AppStateView, SessionTypeView } from '../application/queries/get-state'
import type { SessionConfig } from '../domain/session-config'
import type { JiraProject, JiraSprint, JiraClassification } from '../domain/jira-import'
import type { JiraIssuePreview } from '../application/queries/preview-jira-issues'
import { JiraSourceError } from '../ports/jira-issue-source'
import { asWindowId } from '../domain/ids'
import { viewTaskIdForWindow } from '../application/use-cases/window-groups'

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

/**
 * Re-brand a domain `GroupTree` to the wire `SplitNode` (DESIGN §5.7). The two
 * are declared independently but kept STRUCTURALLY IDENTICAL by design (same
 * discriminants, direction literals and field names) — see the `group-tree.ts`
 * header comment — so this is a plain recursive walk that only widens
 * `SessionId` to `string`, never a shape translation. A small mapper here
 * (rather than a single structural cast) keeps the boundary crossing checked by
 * the compiler against both shapes.
 */
export function toSplitNode(tree: GroupTree): SplitNode {
  if (tree.kind === 'leaf') {
    return { kind: 'leaf', sessionId: tree.sessionId }
  }
  return {
    kind: 'split',
    dir: tree.dir,
    ratio: tree.ratio,
    a: toSplitNode(tree.a),
    b: toSplitNode(tree.b)
  }
}

export function toGroupDTO(g: GroupSnapshot): GroupDTO {
  return {
    id: g.id,
    layout: toSplitNode(g.tree),
    colorIndex: g.colorIndex
  }
}

export function toTaskDTO(t: TaskSnapshot): TaskDTO {
  return {
    id: t.id,
    name: t.name,
    worktree: t.worktree ? toWorktreeRefDTO(t.worktree) : undefined,
    repoLess: t.repoLess ?? false,
    lifecycle: t.lifecycle,
    state: t.state,
    sessions: t.sessions.map(toSessionDTO),
    activeSessionId: t.activeSessionId,
    position: t.position,
    createdAt: t.createdAt,
    // Always present (DESIGN §5.7) — empty when the task has no grouped sessions —
    // even though `TaskSnapshot.groups` is optional (pre-feature snapshots hydrate
    // without it).
    groups: (t.groups ?? []).map(toGroupDTO)
  }
}

/**
 * Map an `IssueSnapshot` to its wire DTO ("Issues", §13.4). Enum values are the DTO
 * strings. `source`/`jiraKey` carry the issue's Jira-import provenance (DESIGN
 * "Jira import") straight across — `IssueSource` enum values are exactly the
 * `IssueSourceDTO` strings, and `jiraKey` is `undefined` for a `local` issue.
 */
export function toIssueDTO(i: IssueSnapshot): IssueDTO {
  return {
    id: i.id,
    name: i.name,
    description: i.description,
    projectPath: i.projectPath,
    status: i.status,
    blockedReasons: i.blockedReasons,
    taskId: i.taskId,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    source: i.source,
    jiraKey: i.jiraKey
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
    terminal: {
      shell: s.terminal.shell,
      stateDetection: s.terminal.stateDetection,
      statusChangeNotifications: s.terminal.statusChangeNotifications
    },
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
    pasteKey: s.pasteKey,
    issuesKey: s.issuesKey,
    splitRightKey: s.splitRightKey,
    splitDownKey: s.splitDownKey,
    focusPaneLeftKey: s.focusPaneLeftKey,
    focusPaneRightKey: s.focusPaneRightKey,
    focusPaneUpKey: s.focusPaneUpKey,
    focusPaneDownKey: s.focusPaneDownKey,
    // `JiraSettings`/`JiraLastFilters` (ports/settings-store.ts) are structurally
    // identical to the DTO's `jira`/`JiraFiltersDTO` shape, so this is a straight
    // passthrough, not a translation (DESIGN "Jira import"). Never carries the API
    // key (I16) — that lives only in `CredentialsProvider`.
    jira: s.jira
  }
}

// ── Jira import (DESIGN "Jira import") ──────────────────────────────────────────

/** A Jira project, as listed by the gateway's project tool. Plain passthrough — the
 * domain and wire shapes are identical ({key, ticketCount}). */
export function toJiraProjectDTO(p: JiraProject): JiraProjectDTO {
  return { key: p.key, ticketCount: p.ticketCount }
}

/** A Jira sprint. Plain passthrough — the domain and wire shapes are identical
 * ({id, name, state}). */
export function toJiraSprintDTO(s: JiraSprint): JiraSprintDTO {
  return { id: s.id, name: s.name, state: s.state }
}

/** Re-brand a domain `JiraClassification` to its wire DTO — same discriminant and
 * fields, only `IssueId` widens to `string`. */
function toJiraClassificationDTO(c: JiraClassification): JiraClassificationDTO {
  if (c.kind === 'new') {
    return { kind: 'new' }
  }
  return { kind: c.kind, issueId: c.issueId, issueName: c.issueName }
}

/**
 * One row of a Jira search result page (`jira:search`), already classified against
 * the workspace by `previewJiraIssues`. The row carries the RAW fetched issue's
 * fields (not `preview.composed`) — `descriptionMarkdown`/`dodMarkdown` are shown
 * separately in the modal, same as `JiraIssue`; only `classification` comes from
 * the preview.
 */
export function toJiraIssueRowDTO(preview: JiraIssuePreview): JiraIssueRowDTO {
  const { issue, classification } = preview
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    priority: issue.priority,
    type: issue.type,
    assignee: issue.assignee,
    reporter: issue.reporter,
    created: issue.created,
    sprintNames: issue.sprints.map((sprint) => sprint.name),
    descriptionMarkdown: issue.descriptionMarkdown,
    dodMarkdown: issue.dodMarkdown,
    classification: toJiraClassificationDTO(classification)
  }
}

/** Mirrors `LiteLLMJiraSource`'s own cap (I1) — kept independent rather than
 * imported so this defensive re-cap doesn't depend on the adapter's constant
 * ever staying in sync; `main` is the only layer both can be reached from. */
const MAX_JIRA_ERROR_MESSAGE_LENGTH = 300

function cap(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_JIRA_ERROR_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_JIRA_ERROR_MESSAGE_LENGTH)}…`
    : trimmed
}

/**
 * Map a thrown error from a `JiraIssueSource` call to the wire `JiraErrorDTO`
 * (DESIGN "Jira import"). A `JiraSourceError`'s `kind`/`message` carry across —
 * the adapter (`LiteLLMJiraSource`) already caps its messages and never includes
 * the API key, `Authorization` header, or an underlying error's raw message
 * (I1). This mapper re-caps `message` anyway as defense in depth: this is the
 * last place before the renderer sees the string, and a future adapter bug that
 * forgets to cap should still not be able to leak an arbitrarily long message
 * over IPC. Anything that ISN'T a `JiraSourceError` (a bug, an unexpected throw)
 * is NOT echoed to the renderer at all: its message could carry arbitrary text
 * (header dumps, stack fragments), so it maps to a fixed, generic `'gateway'`
 * message instead of `String(err)`.
 */
export function toJiraErrorDTO(err: unknown): JiraErrorDTO {
  if (err instanceof JiraSourceError) {
    return { kind: err.kind, message: cap(err.message) }
  }
  return { kind: 'gateway', message: 'an unexpected error occurred contacting the Jira gateway' }
}

export function toWorkspaceStateDTO(view: AppStateView): WorkspaceStateDTO {
  return {
    tasks: view.workspace.tasks.map(toTaskDTO),
    activeTaskId: view.workspace.activeTaskId,
    sessionTypes: view.sessionTypes.map(toSessionTypeDTO),
    settings: toSettingsDTO(view.settings),
    version: view.version,
    issues: (view.workspace.issues ?? []).map(toIssueDTO)
  }
}

export function toWindowDTO(w: WindowRecord): WindowDTO {
  return {
    id: w.id,
    role: w.role,
    bounds: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height },
    createdAt: w.createdAt,
    taskId: w.taskId,
    parentWindowId: w.parentWindowId
  }
}

/**
 * Build the per-window hydration payload (V1.5, §5.6, §6.7): the base workspace
 * state widened with the CALLING window's identity (`thisWindowId`/role, resolved
 * by `main` from `e.sender`) and the full window list. Sessions stay unfiltered;
 * each renderer shows only those whose `windowId` matches its own. Groups
 * (DESIGN §5.7) travel inside each task's `TaskDTO.groups` — no separate
 * per-window layout channel, unlike the first split-pane version. `initialMark`
 * is passed straight through from the caller (`ipc-handlers.ts`'s one-shot
 * window→mark registry) onto the DTO, undefined for every window but the one
 * just created to show a detached session.
 */
export function toWindowedWorkspaceStateDTO(
  view: AppStateView,
  thisWindowId: string,
  thisWindowRole: 'main' | 'secondary' | 'view',
  initialMark?: { taskId: string; sessionId: string }
): WindowedWorkspaceStateDTO {
  // `viewTaskId` (window-view feature) is the task THIS WINDOW'S GROUP is
  // permanently pinned to: set for a `role: 'view'` window AND for a secondary
  // parented to one (`thisWindowRole` stays `'secondary'` for those — only the
  // pin travels, not the role). Resolved via `viewTaskIdForWindow`
  // (`windowGroupRoot` under the hood) over `view.windows` (populated unfiltered
  // by `getState`) rather than threading a separate lookup through the
  // application layer.
  const viewTaskId = viewTaskIdForWindow(view.windows, asWindowId(thisWindowId))
  return {
    ...toWorkspaceStateDTO(view),
    thisWindowId,
    thisWindowRole,
    windows: view.windows.map(toWindowDTO),
    initialMark,
    viewTaskId
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
    case 'groupsChanged':
      return { type: 'groupsChanged', taskId: e.taskId, groups: e.groups.map(toGroupDTO) }
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
        bounds: { x: e.bounds.x, y: e.bounds.y, width: e.bounds.width, height: e.bounds.height },
        taskId: e.taskId,
        parentWindowId: e.parentWindowId
      }
    case 'windowClosed':
      return { type: 'windowClosed', windowId: e.windowId }
    case 'viewCreated':
      return { type: 'viewCreated', windowId: e.windowId, taskId: e.taskId }
    case 'viewClosed':
      return { type: 'viewClosed', windowId: e.windowId, taskId: e.taskId }
    case 'sessionMovedToWindow':
      return {
        type: 'sessionMovedToWindow',
        sessionId: e.sessionId,
        taskId: e.taskId,
        fromWindowId: e.fromWindowId,
        toWindowId: e.toWindowId,
        // Only when present: an explicit move carries no `cause` key at all.
        ...(e.cause !== undefined ? { cause: e.cause } : {})
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
    case 'issueUpserted':
      return { type: 'issueUpserted', issue: toIssueDTO(e.issue) }
    case 'issueDeleted':
      return { type: 'issueDeleted', issueId: e.issueId }
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
