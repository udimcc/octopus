/**
 * IPC command handlers (DESIGN §6.5). Registers one `ipcMain.handle` per
 * request/reply command and two `ipcMain.on` for the fire-and-forget PTY I/O.
 * Each handler maps the inbound wire DTO (string ids, `SessionConfigDTO`) to an
 * application `Command` (domain-branded ids, domain `SessionConfig`) and
 * dispatches it onto the single-writer loop, returning its `CommandResult` as a
 * `CommandAck` (§6.6). `getState` runs the read-model query and maps it to the
 * wire `WorkspaceStateDTO`.
 *
 * This is the inbound boundary: `main` is the only layer that may import both the
 * application/domain and `shared`, so the DTO→command rebranding happens here and
 * nowhere else. Handlers that go through the command loop never throw to the
 * renderer — the loop turns every domain error into `{ ok: false, error }` (§7).
 * The one deliberate exception is `projectListWorktrees` (§6.4): it bypasses the
 * loop (a pure read, like `getState`) and lets an `inspectRepo`/`listWorktrees`
 * rejection propagate, so `ipcRenderer.invoke` rejects and the modal shows the
 * real error instead of an empty list that would look like "no worktrees".
 *
 * `pty:write`/`pty:resize` use `on` (no reply): high-frequency keystrokes/resizes
 * must never head-of-line-block a command reply (§6.5). They still route THROUGH
 * the loop so their ordering relative to close/create is preserved (§6.6).
 */

import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { CHANNELS, type PtyWriteInput, type PtyResizeInput } from '../shared/ipc'
import type {
  CommandAck,
  CreateTaskInput,
  DeleteTaskInput,
  RenameTaskInput,
  ReorderTaskInput,
  SwitchTaskInput,
  CreateSessionInput,
  CloseSessionInput,
  SwitchSessionInput,
  FocusSessionInput,
  RenameSessionInput,
  ReorderSessionInput,
  SessionCwdInput,
  RefreshSessionStateInput,
  MarkSessionSeenInput,
  JoinGroupInput,
  LeaveGroupInput,
  UngroupInput,
  ReorderGroupInput,
  ResizeGroupInput,
  SplitDirection,
  SplitPath,
  CreateWindowInput,
  CloseWindowInput,
  MoveSessionInput,
  CreateWindowWithSessionInput,
  WindowAtPointInput,
  SettingsPatchDTO,
  WindowedWorkspaceStateDTO,
  AddProjectInput,
  RemoveProjectInput,
  SetProjectDefaultBranchInput,
  ListProjectWorktreesInput,
  ProjectListItemDTO,
  ProjectWorktreeDTO,
  CreateIssueInput,
  UpdateIssueInput,
  DeleteIssueInput,
  BindIssueInput,
  UnbindIssueInput,
  OpenExternalInput,
  IssueStatusDTO,
  JiraProjectDTO,
  JiraSprintDTO,
  JiraSearchPageDTO,
  JiraResultDTO,
  ImportJiraIssuesInput,
  ImportJiraIssuesResultDTO,
  SetJiraKeyInput
} from '../shared/dto'
import type { CommandLoop } from '../application/command-loop'
import type { Clipboard } from '../ports/clipboard'
import type { AppDependencies } from '../application/dependencies'
import type { CommandResult } from '../application/commands'
import type { SettingsPatch } from '../application/commands'
import { getState } from '../application/queries/get-state'
import { getSessionCwd } from '../application/queries/get-session-cwd'
import { listProjects } from '../application/queries/list-projects'
import { listProjectWorktrees } from '../application/queries/list-project-worktrees'
import { previewJiraIssues } from '../application/queries/preview-jira-issues'
import {
  asTaskId,
  asSessionId,
  asTypeId,
  asWindowId,
  asIssueId,
  asGroupId,
  MAIN_WINDOW_ID,
  type WindowId,
  type TaskId,
  type SessionId
} from '../domain/ids'
import { parseIssueStatus, type IssueStatus } from '../domain/issue'
import type { JiraSprintFilter } from '../domain/jira-import'
import type { JiraIssueSource, JiraSearchFilters } from '../ports/jira-issue-source'
import { JIRA_API_KEY_REF, type CredentialsProvider } from '../ports/credentials-provider'
import { normalizeJiraIssueKey } from '../shared/jira-key'
import { isPrintableAsciiKey } from '../shared/jira-api-key'
import {
  toWindowedWorkspaceStateDTO,
  toSessionConfig,
  toJiraProjectDTO,
  toJiraSprintDTO,
  toJiraIssueRowDTO,
  toJiraErrorDTO
} from './dto-mappers'
import { openExternalSafely } from './window'

/**
 * Validate a wire issue-status string against the domain enum (§13.4), shared with
 * `mappers.ts`'s defense of a corrupt DB row (`domain/issue.ts`). Returns the parsed
 * status, or `{ error }` if `status` was present but didn't match one of
 * `IssueStatusDTO`'s values — a malformed/stale-client payload, rejected here rather
 * than silently treated as absent (the command's own default, `todo`).
 */
function parseIssueStatusInput(status: IssueStatusDTO | undefined): {
  readonly status?: IssueStatus
  readonly error?: string
} {
  if (status === undefined) {
    return {}
  }
  const parsed = parseIssueStatus(status)
  if (parsed === undefined) {
    return { error: `Invalid issue status: ${String(status)}` }
  }
  return { status: parsed }
}
import { locateSession } from '../application/use-cases/locate-session'

function ack(result: CommandResult): CommandAck {
  return {
    ok: result.ok,
    needsDirtyConfirm: result.needsDirtyConfirm,
    error: result.error,
    windowId: result.windowId,
    // Resolved project returned by `addProject` (§5.4, §6.3). `ProjectSettings` and
    // `ProjectDTO` are structurally identical ({path, defaultBranch?}); copy the
    // fields explicitly rather than forwarding the application type over the wire.
    project: result.project && {
      path: result.project.path,
      defaultBranch: result.project.defaultBranch
    },
    // Id of an issue just created by `createIssue` ("Issues", §13.4).
    issueId: result.issueId
  }
}

/** A rejected `CommandAck` for malformed input, never reaching the command loop. */
function invalidAck(error: string): CommandAck {
  return { ok: false, error }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isSplitDirection(v: unknown): v is SplitDirection {
  return v === 'row' || v === 'col'
}

/** A {@link SplitPath}: an array of only `'a'`/`'b'` steps (possibly empty). */
function isSplitPath(v: unknown): v is SplitPath {
  return Array.isArray(v) && v.every((step) => step === 'a' || step === 'b')
}

// ── Jira import validators (DESIGN "Jira import") ───────────────────────────────
// Pure, exported so tests can target them directly. Unlike the settings store's
// tolerant per-field drop (`json-settings-store.ts`'s `pickJiraLastFiltersCandidate`),
// these REJECT the whole input (return `undefined`) on any malformed field — a
// live search/import request, not a durable settings merge.

/** `days` must be a positive integer no larger than this, so a malformed/huge
 * value can't turn into an oversized gateway query. */
const MAX_FILTER_DAYS = 3650

/** `jira:import` accepts at most this many keys per call. */
const MAX_IMPORT_KEYS = 500

/** Length cap on the free-text filter fields (`assignee`, a free-text `sprint`
 * name), so a pasted blob can't turn into an oversized gateway query. */
const MAX_FILTER_TEXT_LENGTH = 200

/** Length cap on `project` — real keys (`test/fixtures/jira/projects.json`) are
 * well under 10 chars; this is generous headroom, not a tight real-world bound. */
const MAX_PROJECT_KEY_LENGTH = 64

/** Shape of a Jira project key (matches every key in the fixtures: an uppercase
 * letter, then uppercase letters/digits/underscores). Lenient enough for any real
 * Jira project key, which this is — `project` always comes from the dropdown
 * populated by `jira.projects()`, never free-typed. */
const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/

function trimmedOrUndefined(v: string | undefined): string | undefined {
  if (v === undefined) {
    return undefined
  }
  const trimmed = v.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseJiraSprintFilterInput(v: unknown): JiraSprintFilter | undefined {
  if (typeof v !== 'object' || v === null) {
    return undefined
  }
  const candidate = v as Record<string, unknown>
  if (candidate.kind === 'id') {
    if (typeof candidate.id !== 'number' || !Number.isFinite(candidate.id)) {
      return undefined
    }
    if (typeof candidate.name !== 'string' || candidate.name.length > MAX_FILTER_TEXT_LENGTH) {
      return undefined
    }
    return { kind: 'id', id: candidate.id, name: candidate.name }
  }
  if (candidate.kind === 'name') {
    if (typeof candidate.text !== 'string' || candidate.text.length > MAX_FILTER_TEXT_LENGTH) {
      return undefined
    }
    return { kind: 'name', text: candidate.text }
  }
  return undefined
}

/**
 * Validate and normalize a wire `JiraFiltersDTO` for `jira:search` (DESIGN
 * "Jira import"). `project`/`assignee` are trimmed (empty after trimming counts as
 * absent); `project` must additionally match {@link JIRA_PROJECT_KEY_PATTERN} and
 * {@link MAX_PROJECT_KEY_LENGTH}, `assignee` is capped at
 * {@link MAX_FILTER_TEXT_LENGTH}; `issueKey` is normalized via
 * `normalizeJiraIssueKey` and must pass `isJiraIssueKey`; `days` must be a
 * positive integer capped at {@link MAX_FILTER_DAYS}; `sprint` must match one of
 * the two exact tagged-union shapes (its free-text `text`/`name` also capped at
 * {@link MAX_FILTER_TEXT_LENGTH}). Either `project` or a valid `issueKey` is
 * required — mirroring
 * `LiteLLMJiraSource.search`'s single-ticket lookup path, which needs one of the
 * two to do anything. Returns `undefined` for anything else (reject outright,
 * never silently drop a malformed field here).
 */
export function parseJiraFilters(raw: unknown): JiraSearchFilters | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const candidate = raw as Record<string, unknown>

  if (candidate.project !== undefined && typeof candidate.project !== 'string') {
    return undefined
  }
  if (candidate.assignee !== undefined && typeof candidate.assignee !== 'string') {
    return undefined
  }
  const project = trimmedOrUndefined(candidate.project as string | undefined)
  const assignee = trimmedOrUndefined(candidate.assignee as string | undefined)
  if (
    project !== undefined &&
    (project.length > MAX_PROJECT_KEY_LENGTH || !JIRA_PROJECT_KEY_PATTERN.test(project))
  ) {
    return undefined
  }
  if (assignee !== undefined && assignee.length > MAX_FILTER_TEXT_LENGTH) {
    return undefined
  }

  let issueKey: string | undefined
  if (candidate.issueKey !== undefined) {
    if (typeof candidate.issueKey !== 'string') {
      return undefined
    }
    if (candidate.issueKey.trim() !== '') {
      const normalized = normalizeJiraIssueKey(candidate.issueKey)
      if (normalized === undefined) {
        return undefined
      }
      issueKey = normalized
    }
  }

  if (project === undefined && issueKey === undefined) {
    return undefined
  }

  let days: number | undefined
  if (candidate.days !== undefined) {
    if (
      typeof candidate.days !== 'number' ||
      !Number.isInteger(candidate.days) ||
      candidate.days <= 0 ||
      candidate.days > MAX_FILTER_DAYS
    ) {
      return undefined
    }
    days = candidate.days
  }

  let sprint: JiraSprintFilter | undefined
  if (candidate.sprint !== undefined) {
    sprint = parseJiraSprintFilterInput(candidate.sprint)
    if (sprint === undefined) {
      return undefined
    }
  }

  return {
    ...(project !== undefined && { project }),
    ...(assignee !== undefined && { assignee }),
    ...(issueKey !== undefined && { issueKey }),
    ...(days !== undefined && { days }),
    ...(sprint !== undefined && { sprint })
  }
}

/**
 * Validate and normalize `jira:import`'s `keys` (DESIGN "Jira import"): must be a
 * non-empty array capped at {@link MAX_IMPORT_KEYS}, every entry a string that
 * normalizes to a valid Jira issue key (`normalizeJiraIssueKey`/`isJiraIssueKey`).
 * Deduped (first occurrence wins) — a client-side double-checked key can't fetch
 * or import twice. Returns `undefined` for anything else.
 */
export function parseImportKeys(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMPORT_KEYS) {
    return undefined
  }
  const seen = new Set<string>()
  const keys: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      return undefined
    }
    const normalized = normalizeJiraIssueKey(item)
    if (normalized === undefined) {
      return undefined
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      keys.push(normalized)
    }
  }
  return keys
}

/**
 * `credentials:setJiraKey`'s `key`: a trimmed 1–4096 char string of printable
 * ASCII only (I1 — the gateway sends it verbatim in an `Authorization` header,
 * which can't carry whitespace/control/non-ASCII bytes), or `null` to clear.
 * `undefined`/wrong type/out-of-range/bad-character is rejected (returns
 * `undefined`, distinct from the valid `null`) — the caller's rejection message
 * never echoes `raw` itself, so a bad-character key can't leak into a toast.
 */
function parseJiraKeyInput(raw: unknown): string | null | undefined {
  if (raw === null) {
    return null
  }
  if (typeof raw !== 'string') {
    return undefined
  }
  // A pasted `Bearer <key>` (copied from a curl line or header) is accepted — the
  // adapter adds the scheme itself, and the space would fail the character rule.
  const trimmed = raw.trim().replace(/^Bearer\s+/i, '')
  if (trimmed.length < 1 || trimmed.length > 4096) {
    return undefined
  }
  return isPrintableAsciiKey(trimmed) ? trimmed : undefined
}

/** A valid `jira:sprints` project argument: a non-empty string once trimmed. */
function parseJiraSprintsProject(raw: unknown): string | undefined {
  return typeof raw === 'string' ? trimmedOrUndefined(raw) : undefined
}

/** A valid `jira:search` cursor: `undefined`, or the decimal-offset string the
 * adapter itself produces (`LiteLLMJiraSource`'s `nextCursor`, up to 9 digits —
 * comfortably past any real result-count offset). Anything else is a tampered or
 * stale client value; rejecting it here, rather than passing it to
 * `parseCursor`, keeps "garbage cursor" and "garbage filters" symmetric: both
 * fail the request instead of one silently restarting at offset 0. */
function isValidCursor(raw: unknown): raw is string | undefined {
  return raw === undefined || (typeof raw === 'string' && /^\d{1,9}$/.test(raw))
}

export interface IpcHandlerHooks {
  /**
   * webContents.id → WindowId (V1.5, §6.7). Shared with the composition root and
   * filled as windows open; lets `getState`/`windowAtPoint` resolve the calling or
   * pointed-at window from `e.sender` / the OS window list.
   */
  readonly windowIds: Map<number, WindowId>
  /**
   * Called when a window requests `getState` — its hydration call, made AFTER it
   * registered its `onEvent` listener. Wired to the registry's per-window
   * `markReady` so THAT window's buffered startup events flush exactly when it can
   * receive them (§6.7, generalizes the §6.5 single-window hydrate).
   */
  readonly onHydrate?: (windowId: WindowId) => void
  /** OS clipboard adapter backing the terminal copy/paste queries (§5.4). */
  readonly clipboard: Clipboard
  /**
   * The Jira gateway edge (DESIGN "Jira import"). Backs `jira:projects`/
   * `jira:sprints`/`jira:search` (bypass the loop, like `clipboard`) and
   * `jira:import` (fetches outside the loop, then dispatches `importJiraIssues`).
   */
  readonly jira: JiraIssueSource
  /**
   * Secret storage for the Jira API key (DESIGN "Jira import", I16). Backs
   * `credentials:setJiraKey`/`credentials:hasJiraKey`; the key itself never rides
   * back over IPC.
   */
  readonly credentials: CredentialsProvider
  /**
   * Relay a watch-in-place "seen" (§9.5): broadcast a `sessionSeen` event to every
   * window so the ready-for-review view-model clears cross-window. Supplied by the
   * composition root (it owns the window registry); "seen" never touches the command
   * loop or domain bus — it is a pure renderer view-model sync, like the §9.5 toast.
   */
  readonly broadcastSessionSeen?: (sessionId: string) => void
  /**
   * Toggle the Issues drawer (§13.4). The main window toggles its own drawer
   * locally and never calls this; a SECONDARY window's shortcut sends
   * `issue:toggleDrawer`, and this hook relays an `issuesDrawerToggle` event to the
   * main window, then raises/focuses it — never broadcast. Supplied by the
   * composition root (only it owns `BrowserWindow`/the window registry).
   */
  readonly toggleIssuesDrawer?: () => void
}

/** Resolve the WindowId of the calling renderer (`e.sender`), defaulting to main. */
function senderWindowId(windowIds: Map<number, WindowId>, sender: Electron.WebContents): WindowId {
  return windowIds.get(sender.id) ?? MAIN_WINDOW_ID
}

/**
 * Register every IPC handler against the command loop + deps. Called once at the
 * end of bootstrap, before any window loads.
 */
export function registerIpcHandlers(
  loop: CommandLoop,
  deps: AppDependencies,
  hooks: IpcHandlerHooks
): void {
  // One-shot window→mark registry (DESIGN §3.7, §5.7 round 2): recorded ONLY for a
  // window just opened via `windows:createWithSession` (`windowCreateWithSession`
  // below), so that window's first `getState` can mark the detached session
  // instead of falling back to the task's persisted (and, for a hidden-until-shown
  // new window, stale) `activeSessionId`. Deleted in `appGetState` right after it is
  // read, so a LATER re-hydrate of the same window (SettingsModal's re-hydrate, or a
  // renderer crash-reload) falls through to the normal mark priority instead of
  // replaying the detach-time session every time. The `windowClosed` cleanup
  // (subscribed below) only matters for a window that closes before ever calling
  // `getState`.
  const initialMarks = new Map<WindowId, { taskId: TaskId; sessionId: SessionId }>()
  deps.bus.subscribe((event) => {
    if (event.type === 'windowClosed') {
      initialMarks.delete(event.windowId)
    }
  })

  // Health check (kept from V0).
  ipcMain.handle(CHANNELS.ping, () => 'pong')

  // ── Task commands ─────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.taskCreate, async (_e, input: CreateTaskInput): Promise<CommandAck> => {
    // The DTO and the application command share the same `mode`-discriminated
    // shape (all string fields, no branded ids), so forward it verbatim EXCEPT
    // `issueId`, which must be rebranded to the domain `IssueId` (§13.4).
    const result = await loop.dispatch({
      kind: 'createTask',
      input: {
        ...input,
        issueId: input.issueId !== undefined ? asIssueId(input.issueId) : undefined
      }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskDelete, async (_e, input: DeleteTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'deleteTask',
      input: {
        taskId: asTaskId(input.taskId),
        force: input.force,
        confirmedDirty: input.confirmedDirty,
        // "Delete both" (§13.4): applied only in the task's final delete transaction.
        alsoDeleteIssue: input.alsoDeleteIssue
      }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskRename, async (_e, input: RenameTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'renameTask',
      input: { taskId: asTaskId(input.taskId), name: input.name }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskReorder, async (_e, input: ReorderTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'reorderTask',
      input: { taskId: asTaskId(input.taskId), toIndex: input.toIndex }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskSwitch, async (_e, input: SwitchTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'switchTask',
      input: { taskId: asTaskId(input.taskId) }
    })
    return ack(result)
  })

  // ── Session commands ──────────────────────────────────────────────────────
  ipcMain.handle(
    CHANNELS.sessionCreate,
    async (e, input: CreateSessionInput): Promise<CommandAck> => {
      // Split intent (DESIGN §5.7): the split shortcut / tab-menu "Split right|down"
      // creates the session already joined into the anchor's group, in one command.
      // Malformed input is rejected outright rather than silently created lone — a
      // defensive check in the handler's existing style (cf. the group:* handlers).
      // `input?.split` + an explicit `null` check (review#5): a bare
      // `input.split !== undefined` check lets `split: null` through (`null !==
      // undefined` is true), and the very next line then dereferences
      // `input.split.anchorSessionId` on `null` and throws — crashing the handler
      // instead of returning `{ ok: false }`. A present-but-`null`/non-object
      // `split` is rejected the same way a malformed non-null one is.
      const split = input?.split
      if (
        split !== undefined &&
        (split === null ||
          typeof split !== 'object' ||
          !isNonEmptyString(split.anchorSessionId) ||
          !isSplitDirection(split.dir))
      ) {
        return invalidAck('session:create: invalid split input')
      }
      // Host the new session in the window that asked for it (V1.5, §6.7). Resolve
      // the calling renderer the same way getState/windowAtPoint do — the renderer
      // needn't pass its own id over the wire.
      const windowId = senderWindowId(hooks.windowIds, e.sender)
      const result = await loop.dispatch({
        kind: 'createSession',
        input: {
          taskId: asTaskId(input.taskId),
          typeId: input.typeId !== undefined ? asTypeId(input.typeId) : undefined,
          title: input.title,
          config: input.config !== undefined ? toSessionConfig(input.config) : undefined,
          windowId,
          split:
            split !== undefined
              ? { anchorSessionId: asSessionId(split.anchorSessionId), dir: split.dir }
              : undefined
        }
      })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.sessionClose,
    async (_e, input: CloseSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'closeSession',
        input: { sessionId: asSessionId(input.sessionId) }
      })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.sessionSwitch,
    async (_e, input: SwitchSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'switchSession',
        input: { sessionId: asSessionId(input.sessionId) }
      })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.sessionRename,
    async (_e, input: RenameSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'renameSession',
        input: { sessionId: asSessionId(input.sessionId), title: input.title }
      })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.sessionReorder,
    async (_e, input: ReorderSessionInput): Promise<CommandAck> => {
      // Validated at the wire boundary (m1), consistent with `group:reorder` below:
      // `Task.reorderSession` now throws on a non-integer/negative `toIndex` too,
      // but rejecting it here avoids a round trip through the command loop/domain
      // error path for input that is obviously malformed before it ever leaves IPC.
      if (!Number.isInteger(input?.toIndex) || input.toIndex < 0) {
        return invalidAck('session:reorder: invalid input')
      }
      const result = await loop.dispatch({
        kind: 'reorderSession',
        input: {
          taskId: asTaskId(input.taskId),
          sessionId: asSessionId(input.sessionId),
          toIndex: input.toIndex
        }
      })
      return ack(result)
    }
  )

  // ── Session move (V1.5, §3.7) ───────────────────────────────────────────────
  ipcMain.handle(CHANNELS.sessionMove, async (_e, input: MoveSessionInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'moveSessionToWindow',
      input: {
        sessionId: asSessionId(input.sessionId),
        targetWindowId: asWindowId(input.targetWindowId)
      }
    })
    return ack(result)
  })

  // A session's live cwd (query, bypasses the loop, §6.5). Reads the live runtime
  // handle straight from deps.runtimes; maps undefined → null for the wire. Powers
  // "new terminal from this directory".
  ipcMain.handle(
    CHANNELS.sessionCwd,
    async (_e, input: SessionCwdInput): Promise<string | null> => {
      const cwd = await getSessionCwd(deps, asSessionId(input.sessionId))
      return cwd ?? null
    }
  )

  // ── Group commands (DESIGN §5.7) ────────────────────────────────────────────
  // Each mutates the `Task` aggregate and resolves to a `CommandAck`; the result
  // itself arrives separately as a `groupsChanged` event (plus `sessionReordered`
  // when membership reorders tabs) — same split as the session commands above.
  // Malformed input is rejected with `{ ok: false }` before it ever reaches the
  // loop, the defensive style the removed `layout:save` handler used.
  ipcMain.handle(CHANNELS.groupJoin, async (_e, input: JoinGroupInput): Promise<CommandAck> => {
    if (
      !isNonEmptyString(input?.sessionId) ||
      !isNonEmptyString(input?.anchorSessionId) ||
      !isSplitDirection(input?.dir)
    ) {
      return invalidAck('group:join: invalid input')
    }
    const result = await loop.dispatch({
      kind: 'joinGroup',
      input: {
        sessionId: asSessionId(input.sessionId),
        anchorSessionId: asSessionId(input.anchorSessionId),
        dir: input.dir
      }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.groupLeave, async (_e, input: LeaveGroupInput): Promise<CommandAck> => {
    if (!isNonEmptyString(input?.sessionId)) {
      return invalidAck('group:leave: invalid input')
    }
    const result = await loop.dispatch({
      kind: 'leaveGroup',
      input: { sessionId: asSessionId(input.sessionId) }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.groupUngroup, async (_e, input: UngroupInput): Promise<CommandAck> => {
    if (!isNonEmptyString(input?.taskId) || !isNonEmptyString(input?.groupId)) {
      return invalidAck('group:ungroup: invalid input')
    }
    const result = await loop.dispatch({
      kind: 'ungroup',
      input: { taskId: asTaskId(input.taskId), groupId: asGroupId(input.groupId) }
    })
    return ack(result)
  })

  ipcMain.handle(
    CHANNELS.groupReorder,
    async (_e, input: ReorderGroupInput): Promise<CommandAck> => {
      if (
        !isNonEmptyString(input?.taskId) ||
        !isNonEmptyString(input?.groupId) ||
        !Number.isInteger(input?.toIndex) ||
        input.toIndex < 0
      ) {
        return invalidAck('group:reorder: invalid input')
      }
      const result = await loop.dispatch({
        kind: 'reorderGroup',
        input: {
          taskId: asTaskId(input.taskId),
          groupId: asGroupId(input.groupId),
          toIndex: input.toIndex
        }
      })
      return ack(result)
    }
  )

  ipcMain.handle(CHANNELS.groupResize, async (_e, input: ResizeGroupInput): Promise<CommandAck> => {
    if (
      !isNonEmptyString(input?.taskId) ||
      !isNonEmptyString(input?.groupId) ||
      !isSplitPath(input?.path) ||
      typeof input?.ratio !== 'number' ||
      !Number.isFinite(input.ratio)
    ) {
      return invalidAck('group:resize: invalid input')
    }
    const result = await loop.dispatch({
      kind: 'resizeGroup',
      input: {
        taskId: asTaskId(input.taskId),
        groupId: asGroupId(input.groupId),
        path: input.path,
        ratio: input.ratio
      }
    })
    return ack(result)
  })

  // ── Window commands (V1.5, §6.7) ────────────────────────────────────────────
  ipcMain.handle(
    CHANNELS.windowCreate,
    async (_e, input: CreateWindowInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'createWindow',
        input: { role: 'secondary', bounds: input.bounds }
      })
      return ack(result)
    }
  )

  ipcMain.handle(CHANNELS.windowClose, async (_e, input: CloseWindowInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'closeWindow',
      input: { windowId: asWindowId(input.windowId), disposition: input.disposition }
    })
    return ack(result)
  })

  ipcMain.handle(
    CHANNELS.windowCreateWithSession,
    async (_e, input: CreateWindowWithSessionInput): Promise<CommandAck> => {
      const sessionId = asSessionId(input.sessionId)
      const result = await loop.dispatch({
        kind: 'createWindowWithSession',
        input: { sessionId, bounds: input.bounds }
      })
      // Record the new window's one-shot mark (see `initialMarks` above) so its
      // OWN first `getState` shows the detached session — not whatever the task's
      // persisted `activeSessionId` says — even though the new window is created
      // hidden and the SOURCE window (still focused) races ahead and re-marks the
      // task via `sessions.focus` before the new window ever hydrates. `located`
      // is re-resolved post-move rather than reusing anything from the command: the
      // session's `taskId` never changes across a window move, so this is just
      // the simplest way to get it.
      if (result.ok && result.windowId) {
        const located = locateSession(deps.workspace, sessionId)
        if (located) {
          initialMarks.set(result.windowId, { taskId: located.task.id, sessionId })
        }
      }
      return ack(result)
    }
  )

  // Hit-test a screen point against open windows (query, bypasses the loop, §6.7).
  // Returns the WindowId whose OS bounds contain the point, or null (empty desktop).
  ipcMain.handle(CHANNELS.windowAtPoint, (_e, input: WindowAtPointInput): string | null => {
    const point = { x: Math.round(input.x), y: Math.round(input.y) }
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !win.isVisible()) {
        continue
      }
      const b = win.getBounds()
      const inside =
        point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
      if (inside) {
        return hooks.windowIds.get(win.webContents.id) ?? null
      }
    }
    return null
  })

  // ── Project commands (§5.4, §6.3) ───────────────────────────────────────────
  ipcMain.handle(CHANNELS.projectAdd, async (_e, input: AddProjectInput): Promise<CommandAck> => {
    const result = await loop.dispatch({ kind: 'addProject', input })
    return ack(result)
  })

  ipcMain.handle(
    CHANNELS.projectRemove,
    async (_e, input: RemoveProjectInput): Promise<CommandAck> => {
      const result = await loop.dispatch({ kind: 'removeProject', input })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.projectSetDefaultBranch,
    async (_e, input: SetProjectDefaultBranchInput): Promise<CommandAck> => {
      const result = await loop.dispatch({ kind: 'setProjectDefaultBranch', input })
      return ack(result)
    }
  )

  // Pure read, bypasses the loop like getSessionCwd (§6.3).
  ipcMain.handle(CHANNELS.projectList, (): readonly ProjectListItemDTO[] => listProjects(deps))

  // Pure read, bypasses the loop (§6.4). `listWorktrees` shells out to git and can
  // reject (non-git dir, git missing, etc.); we deliberately let that rejection
  // propagate so `ipcRenderer.invoke` rejects and the modal surfaces an inline
  // error, rather than swallowing it into an empty `[]` that would look like "this
  // project has no worktrees" and hide the real failure.
  ipcMain.handle(
    CHANNELS.projectListWorktrees,
    async (_e, input: ListProjectWorktreesInput): Promise<readonly ProjectWorktreeDTO[]> =>
      listProjectWorktrees(deps, input.projectPath)
  )

  // ── Issue commands ("Issues", §13.4) ────────────────────────────────────────
  ipcMain.handle(CHANNELS.issueCreate, async (_e, input: CreateIssueInput): Promise<CommandAck> => {
    if (typeof input.name !== 'string' || typeof input.description !== 'string') {
      return ack({ ok: false, error: 'Invalid issue name or description' })
    }
    const status = parseIssueStatusInput(input.status)
    if (status.error) {
      return ack({ ok: false, error: status.error })
    }
    const result = await loop.dispatch({
      kind: 'createIssue',
      input: {
        name: input.name,
        description: input.description,
        projectPath: input.projectPath,
        status: status.status
      }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.issueUpdate, async (_e, input: UpdateIssueInput): Promise<CommandAck> => {
    if (input.name !== undefined && typeof input.name !== 'string') {
      return ack({ ok: false, error: 'Invalid issue name' })
    }
    if (input.description !== undefined && typeof input.description !== 'string') {
      return ack({ ok: false, error: 'Invalid issue description' })
    }
    const status = parseIssueStatusInput(input.status)
    if (status.error) {
      return ack({ ok: false, error: status.error })
    }
    const result = await loop.dispatch({
      kind: 'updateIssue',
      input: {
        issueId: asIssueId(input.issueId),
        name: input.name,
        description: input.description,
        // `null` explicitly clears the project; `undefined`/omitted leaves it as is.
        projectPath: input.projectPath,
        status: status.status
      }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.issueDelete, async (_e, input: DeleteIssueInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'deleteIssue',
      input: { issueId: asIssueId(input.issueId) }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.issueBind, async (_e, input: BindIssueInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'bindIssue',
      input: { issueId: asIssueId(input.issueId), taskId: asTaskId(input.taskId) }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.issueUnbind, async (_e, input: UnbindIssueInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'unbindIssue',
      input: { issueId: asIssueId(input.issueId) }
    })
    return ack(result)
  })

  // Secondary-window drawer-toggle relay (§13.4): raise/focus the main window and
  // relay the toggle there; the main window toggles its own store locally and never
  // sends this. Fire-and-forget, like `session:markSeen`.
  ipcMain.on(CHANNELS.issuesToggleDrawer, () => {
    hooks.toggleIssuesDrawer?.()
  })

  // Open a URL in the system browser (§13.4): a validated command, not a bare
  // `shell.openExternal` passthrough. `openExternalSafely` (shared with
  // `window.ts`'s `setWindowOpenHandler`) re-validates/normalizes the URL here too
  // (defense in depth beyond the renderer's own pre-check) and only http/https
  // ever reaches Electron's `shell.openExternal`; anything else, or a
  // rejected/throwing open, is a silent `false` rather than a thrown error (a
  // failed open is logged — see `openExternalSafely`).
  ipcMain.handle(
    CHANNELS.shellOpenExternal,
    async (_e, input: OpenExternalInput): Promise<boolean> => {
      if (typeof input !== 'object' || input === null || typeof input.url !== 'string') {
        return false
      }
      return openExternalSafely(input.url)
    }
  )

  // ── Jira import (DESIGN "Jira import") ──────────────────────────────────────
  // `projects`/`sprints`/`search` are stateless queries that bypass the command
  // loop, like `clipboard`/`projectList` — they only read through the gateway and
  // classify against the CURRENT workspace, never mutate it. Invalid input is
  // rejected (`{ ok: false, error: { kind: 'invalid' } }`) before any port call; a
  // port throw is mapped by `toJiraErrorDTO`.
  ipcMain.handle(
    CHANNELS.jiraProjects,
    async (): Promise<JiraResultDTO<readonly JiraProjectDTO[]>> => {
      try {
        const projects = await hooks.jira.listProjects()
        return { ok: true, value: projects.map(toJiraProjectDTO) }
      } catch (err) {
        return { ok: false, error: toJiraErrorDTO(err) }
      }
    }
  )

  ipcMain.handle(
    CHANNELS.jiraSprints,
    async (_e, projectRaw: unknown): Promise<JiraResultDTO<readonly JiraSprintDTO[]>> => {
      const project = parseJiraSprintsProject(projectRaw)
      if (project === undefined) {
        return { ok: false, error: { kind: 'invalid', message: 'invalid Jira project' } }
      }
      try {
        const sprints = await hooks.jira.listSprints(project)
        return { ok: true, value: sprints.map(toJiraSprintDTO) }
      } catch (err) {
        return { ok: false, error: toJiraErrorDTO(err) }
      }
    }
  )

  ipcMain.handle(
    CHANNELS.jiraSearch,
    async (
      _e,
      filtersRaw: unknown,
      cursorRaw: unknown
    ): Promise<JiraResultDTO<JiraSearchPageDTO>> => {
      const filters = parseJiraFilters(filtersRaw)
      if (filters === undefined || !isValidCursor(cursorRaw)) {
        return { ok: false, error: { kind: 'invalid', message: 'invalid Jira search filters' } }
      }
      try {
        const page = await hooks.jira.search(filters, cursorRaw)
        // Classify against the workspace's CURRENT issues (§preview). `total` is
        // passed through as-is: the port's `JiraSearchPage.total` is the
        // UNFILTERED gateway total even when a sprint filter narrowed `rows`.
        const previews = previewJiraIssues(deps, page.issues)
        return {
          ok: true,
          value: {
            rows: previews.map(toJiraIssueRowDTO),
            nextCursor: page.nextCursor,
            total: page.total
          }
        }
      } catch (err) {
        return { ok: false, error: toJiraErrorDTO(err) }
      }
    }
  )

  // `import` DOES mutate (it creates issues), so unlike the queries above it
  // dispatches through the loop — but only AFTER fetching the issues from the
  // gateway outside it (§6.6 "single-writer domain" stays I/O-light, mirroring
  // `createTask`'s already-resolved `repoDir`).
  ipcMain.handle(
    CHANNELS.jiraImport,
    async (_e, input: ImportJiraIssuesInput): Promise<ImportJiraIssuesResultDTO> => {
      const rawKeys = input?.keys
      // Distinct from the generic "invalid" rejection below (M8): an over-length
      // list is a real, well-formed selection the renderer should cap client-side
      // and retry, not a malformed payload — "invalid Jira issue keys" was
      // confusing someone who had simply selected too many rows.
      if (Array.isArray(rawKeys) && rawKeys.length > MAX_IMPORT_KEYS) {
        return {
          ok: false,
          importedCount: 0,
          skippedKeys: [],
          error: { kind: 'invalid', message: `at most ${MAX_IMPORT_KEYS} issues per import` }
        }
      }
      const keys = parseImportKeys(rawKeys)
      if (keys === undefined) {
        return {
          ok: false,
          importedCount: 0,
          skippedKeys: [],
          error: { kind: 'invalid', message: 'invalid Jira issue keys' }
        }
      }

      let fetched
      try {
        fetched = await hooks.jira.getIssues(keys)
      } catch (err) {
        return { ok: false, importedCount: 0, skippedKeys: [], error: toJiraErrorDTO(err) }
      }

      // Keys the gateway didn't return (deleted/mistyped/no access) are reported
      // as skipped, same as a duplicate/conflict the command re-classifies.
      const fetchedKeys = new Set(fetched.map((issue) => issue.key))
      const missingKeys = keys.filter((key) => !fetchedKeys.has(key))

      const result = await loop.dispatch({
        kind: 'importJiraIssues',
        input: { issues: fetched }
      })

      if (!result.ok) {
        // A persistence/domain failure, not a Jira-gateway one — there is no
        // dedicated `JiraErrorDTO` kind for it; `'gateway'` is the closest existing
        // bucket (the modal shows `error.message` regardless of `kind`). Worth a
        // dedicated kind (e.g. `'internal'`) if this needs distinct UI treatment.
        return {
          ok: false,
          importedCount: 0,
          skippedKeys: [],
          error: { kind: 'gateway', message: result.error ?? 'import failed' }
        }
      }

      return {
        ok: true,
        importedCount: result.importedCount ?? 0,
        skippedKeys: [...(result.skippedKeys ?? []), ...missingKeys]
      }
    }
  )

  // ── Jira API key (DESIGN "Jira import", I16) ────────────────────────────────
  // Backed by `CredentialsProvider`, encrypted at rest. The key is set-only from
  // the renderer's point of view: it is never read back, never logged, and never
  // included in an error message (`SafeStorageCredentials`'s own messages never
  // carry the secret).
  ipcMain.handle(
    CHANNELS.credentialsSetJiraKey,
    async (_e, input: SetJiraKeyInput): Promise<CommandAck> => {
      const key = parseJiraKeyInput(input?.key)
      if (key === undefined) {
        return invalidAck('credentials:setJiraKey: invalid key')
      }
      try {
        await hooks.credentials.set(JIRA_API_KEY_REF, key)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'failed to store credential'
        }
      }
    }
  )

  ipcMain.handle(CHANNELS.credentialsHasJiraKey, async (): Promise<boolean> => {
    return hooks.credentials.has(JIRA_API_KEY_REF)
  })

  // ── App-level ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.appGetState, (e): WindowedWorkspaceStateDTO => {
    // Resolve WHICH window is hydrating so we can stamp its identity + mark only it
    // ready (§6.7). Its role comes from the persisted window record (main by default).
    const windowId = senderWindowId(hooks.windowIds, e.sender)
    const view = getState(deps)
    const record = view.windows.find((w) => w.id === windowId)
    const role: 'main' | 'secondary' = record?.role ?? 'main'
    const dto = toWindowedWorkspaceStateDTO(view, windowId, role, initialMarks.get(windowId))
    // One-shot (see `initialMarks` above): consumed by this window's first getState only.
    initialMarks.delete(windowId)
    // This window registered onEvent before the call; flush its buffered events.
    hooks.onHydrate?.(windowId)
    return dto
  })

  // The running app's release version (semver from package.json). Stateless query,
  // bypasses the command loop. Distinct from the feature-set version in the state DTO.
  ipcMain.handle(CHANNELS.appGetVersion, (): string => app.getVersion())

  ipcMain.handle(
    CHANNELS.appUpdateSettings,
    async (_e, patch: SettingsPatchDTO): Promise<CommandAck> => {
      // SettingsPatchDTO is structurally the application SettingsPatch.
      const result = await loop.dispatch({
        kind: 'updateSettings',
        input: patch as SettingsPatch
      })
      return ack(result)
    }
  )

  // Native directory picker for the New-Task modal (§5.4). A stateless query, so
  // it bypasses the command loop (like getState). Anchored to the requesting
  // window so the dialog is modal; `createDirectory` lets the user make a new repo
  // folder inline. Returns the chosen absolute path, or undefined on cancel.
  ipcMain.handle(CHANNELS.dialogPickDirectory, async (e): Promise<string | undefined> => {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return undefined
    }
    return result.filePaths[0]
  })

  // Clipboard read/write for terminal copy/paste (§5.4). Stateless queries over the
  // OS clipboard adapter, bypassing the command loop (like dialogPickDirectory).
  ipcMain.handle(CHANNELS.clipboardRead, (): string => hooks.clipboard.readText())
  ipcMain.handle(CHANNELS.clipboardWrite, (_e, text: string): void =>
    hooks.clipboard.writeText(text)
  )

  // ── Fire-and-forget PTY I/O (no reply, §6.5) ────────────────────────────────
  ipcMain.on(CHANNELS.ptyWrite, (_e, input: PtyWriteInput) => {
    void loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId: asSessionId(input.sessionId), data: input.data }
    })
  })

  ipcMain.on(CHANNELS.ptyResize, (_e, input: PtyResizeInput) => {
    void loop.dispatch({
      kind: 'resizePty',
      input: { sessionId: asSessionId(input.sessionId), cols: input.cols, rows: input.rows }
    })
  })

  // Manual state refresh (§5.4 R1): fire-and-forget, like PTY I/O. The refreshed
  // state, if any, surfaces asynchronously as a `sessionStateChanged` event.
  ipcMain.on(CHANNELS.sessionRefreshState, (_e, input: RefreshSessionStateInput) => {
    void loop.dispatch({
      kind: 'refreshSessionState',
      input: { sessionId: asSessionId(input.sessionId) }
    })
  })

  // Last-focused-session persist (§5.4, I10): fire-and-forget, like the refresh above.
  // Routed through the loop because it writes the task row, but it emits no event and
  // raises no window — the renderer already shows the mark it's reporting.
  ipcMain.on(CHANNELS.sessionFocus, (_e, input: FocusSessionInput) => {
    void loop.dispatch({
      kind: 'focusSession',
      input: { sessionId: asSessionId(input.sessionId) }
    })
  })

  // Watch-in-place "seen" relay (§9.5): fire-and-forget, does NOT go through the loop
  // or the domain bus — "seen" is a pure renderer view-model. Main just broadcasts the
  // clear so every window's ready-for-review folds it in (the cross-window piece a
  // same-window `markVisibleSessionSeen` can't reach).
  ipcMain.on(CHANNELS.sessionMarkSeen, (_e, input: MarkSessionSeenInput) => {
    hooks.broadcastSessionSeen?.(input.sessionId)
  })
}
