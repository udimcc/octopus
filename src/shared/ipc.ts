/**
 * Transport-agnostic IPC contract shared by main, preload and renderer
 * (DESIGN §6.5). Keeping the message set here — rather than inline in Electron
 * IPC calls — means the V2 durable-session daemon can carry the same protocol
 * over a Unix socket unchanged.
 *
 * Two channel shapes (§6.5):
 *   - request/reply COMMANDS (`ipcMain.handle` ↔ `ipcRenderer.invoke`): every
 *     mutation + `getState`; each resolves to a `CommandAck` (or the state DTO).
 *   - fire-and-forget: `pty:write`/`pty:resize` (renderer → main, `send`) and the
 *     single `app:event` stream (main → renderer, `webContents.send`). Streaming
 *     `ptyData` uses `send` so high-frequency output never head-of-line-blocks a
 *     command reply (§6.5).
 */

import type {
  WindowedWorkspaceStateDTO,
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
  CreateWindowInput,
  CloseWindowInput,
  MoveSessionInput,
  CreateWindowWithSessionInput,
  WindowAtPointInput,
  SettingsPatchDTO,
  ProjectListItemDTO,
  ProjectWorktreeDTO,
  AddProjectInput,
  RemoveProjectInput,
  SetProjectDefaultBranchInput,
  ListProjectWorktreesInput,
  CreateIssueInput,
  UpdateIssueInput,
  DeleteIssueInput,
  BindIssueInput,
  UnbindIssueInput,
  OpenExternalInput,
  JiraProjectDTO,
  JiraSprintDTO,
  JiraFiltersDTO,
  JiraSearchPageDTO,
  JiraResultDTO,
  ImportJiraIssuesInput,
  ImportJiraIssuesResultDTO,
  SetJiraKeyInput
} from './dto'
import type { EventDTO } from './events'

/** IPC channel names. One per request/reply command; one shared event stream. */
export const CHANNELS = {
  /** V0 health check: renderer → main → 'pong'. */
  ping: 'app:ping',

  // Task commands (UI → backend, request/reply).
  taskCreate: 'task:create',
  taskDelete: 'task:delete',
  taskRename: 'task:rename',
  taskReorder: 'task:reorder',
  taskSwitch: 'task:switch',

  // Session commands (UI → backend, request/reply).
  sessionCreate: 'session:create',
  sessionClose: 'session:close',
  sessionSwitch: 'session:switch',
  sessionRename: 'session:rename',
  sessionReorder: 'session:reorder',
  sessionMove: 'session:move',

  /**
   * Report a finished-turn session watched IN PLACE (renderer → main, fire-and-forget,
   * §9.5). Like `session:refreshState` it's a `send` (no reply): main broadcasts a
   * `sessionSeen` event to every window so the "unseen finished turn" view-model clears
   * across windows — the piece a same-window `markVisibleSessionSeen` can't reach.
   */
  sessionMarkSeen: 'session:markSeen',

  /**
   * Persist the focused window's marked session as the task's "last focused session"
   * (renderer → main, fire-and-forget, §5.4, I10). Like `session:markSeen` it's a
   * `send` (no reply). Routed through the command loop (it writes the task row) but
   * emits NO event and raises no window — unlike `session:switch`.
   */
  sessionFocus: 'session:focus',

  /**
   * A session's live current working directory (request/reply). A stateless
   * main-side QUERY — like `getState`, it does NOT go through the command loop
   * (§6.5). Reads the live runtime's cwd (via `/proc/<pid>/cwd`); resolves to the
   * path, or `null` if it can't be resolved (exited/non-terminal/non-Linux).
   */
  sessionCwd: 'session:cwd',

  /**
   * Manually re-evaluate a session's state (renderer → main, fire-and-forget). Like
   * `pty:write` it's a `send` (no reply): the refreshed state, if any, comes back
   * asynchronously as an ordinary `sessionStateChanged` event (§5.4 R1, §9.6). Still
   * routed through the command loop so it orders against close/create.
   */
  sessionRefreshState: 'session:refreshState',

  // Group commands (UI → backend, request/reply) (DESIGN §5.7).
  groupJoin: 'group:join',
  groupLeave: 'group:leave',
  groupUngroup: 'group:ungroup',
  groupReorder: 'group:reorder',
  groupResize: 'group:resize',

  // Window commands (UI → backend, request/reply) (V1.5, §6.7).
  windowCreate: 'window:create',
  windowClose: 'window:close',
  windowCreateWithSession: 'window:createWithSession',

  // Project commands (UI → backend, request/reply) (defined projects, §5.4, §6.3).
  projectList: 'project:list',
  projectAdd: 'project:add',
  projectRemove: 'project:remove',
  projectSetDefaultBranch: 'project:setDefaultBranch',
  projectListWorktrees: 'project:listWorktrees',

  // Issue commands (UI → backend, request/reply) ("Issues", §13.4).
  issueCreate: 'issue:create',
  issueUpdate: 'issue:update',
  issueDelete: 'issue:delete',
  issueBind: 'issue:bind',
  issueUnbind: 'issue:unbind',

  /**
   * Toggle the Issues drawer (renderer → main, fire-and-forget, "Issues", §13.4). Sent
   * by a SECONDARY window's shortcut (there is no drawer to toggle locally); main relays
   * an `issuesDrawerToggle` event to the main window, then raises and focuses it. The
   * main window itself toggles its own drawer locally and never sends this.
   */
  issuesToggleDrawer: 'issue:toggleDrawer',

  /**
   * Open a URL in the system browser (request/reply), after checking it via
   * `openExternalSafely` (`toSafeExternalUrl`) main-side. Resolves to whether it was
   * opened.
   */
  shellOpenExternal: 'shell:openExternal',

  // PTY I/O (UI → backend, fire-and-forget: high-frequency, no reply).
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',

  // App-level (request/reply).
  appGetState: 'app:getState',
  appUpdateSettings: 'app:updateSettings',

  /**
   * The running app's release version (request/reply). A stateless main-side QUERY
   * (resolves `app.getVersion()`, i.e. package.json's version) that bypasses the
   * command loop, like `getState`. Distinct from the feature-set `CURRENT_VERSION`
   * carried in the state DTO (§10): this is the semver shown to the user.
   */
  appGetVersion: 'app:getVersion',

  /**
   * Native directory picker (request/reply). A stateless main-side QUERY — like
   * `getState`, it does NOT go through the command loop (§6.5). Resolves to the
   * chosen absolute path, or `undefined` if the user cancelled.
   */
  dialogPickDirectory: 'dialog:pickDirectory',

  /**
   * Hit-test a screen-space point against the open windows (request/reply). Like
   * `dialogPickDirectory`, a stateless main-side QUERY that bypasses the command
   * loop (§6.7). Resolves to the `windowId` under the point, or `null` if none.
   */
  windowAtPoint: 'window:atPoint',

  /**
   * The calling renderer's own window id (request/reply). Serviced SYNCHRONOUSLY
   * in preload from `?windowId=` — this channel exists for contract completeness;
   * the preload never actually round-trips it (§5.6).
   */
  appGetWindowId: 'app:getWindowId',

  /**
   * Clipboard read/write (request/reply) for terminal copy/paste (§5.4). Stateless
   * main-side QUERIES over Electron's `clipboard` module — like `dialogPickDirectory`,
   * they do NOT go through the command loop (§6.5).
   */
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  /**
   * Jira import queries (request/reply, DESIGN §13.7). `jiraProjects`, `jiraSprints`
   * and `jiraSearch` are stateless main-side QUERIES that bypass the command loop,
   * like `dialogPickDirectory` — they only read through the gateway and classify
   * against the current workspace, never mutate it. `jiraImport` DOES mutate (it
   * creates issues), so it dispatches through the loop after main fetches the
   * issues outside it.
   */
  jiraProjects: 'jira:projects',
  jiraSprints: 'jira:sprints',
  jiraSearch: 'jira:search',
  jiraImport: 'jira:import',

  /**
   * The Jira API key (request/reply, DESIGN §13.7, I16). Backed by
   * `CredentialsProvider`, encrypted at rest; the key itself never returns to the
   * renderer — `credentialsHasJiraKey` resolves only a boolean.
   */
  credentialsSetJiraKey: 'credentials:setJiraKey',
  credentialsHasJiraKey: 'credentials:hasJiraKey',

  /** Streaming events (backend → UI, webContents.send). Carries a discriminated EventDTO. */
  event: 'app:event'
} as const

/** Payload of a `pty:write` message. */
export interface PtyWriteInput {
  readonly sessionId: string
  readonly data: string
}

/** Payload of a `pty:resize` message. */
export interface PtyResizeInput {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
}

/**
 * The API surface exposed to the renderer via `window.octopusAPI`
 * (contextBridge, DESIGN §5.5). The renderer never touches ipcRenderer directly.
 * Grouped by concern; commands resolve to a `CommandAck` unless noted.
 */
export interface OctopusAPI {
  /** Round-trip health check; resolves to 'pong'. */
  ping(): Promise<string>

  tasks: {
    create(input: CreateTaskInput): Promise<CommandAck>
    delete(input: DeleteTaskInput): Promise<CommandAck>
    rename(input: RenameTaskInput): Promise<CommandAck>
    reorder(input: ReorderTaskInput): Promise<CommandAck>
    switch(input: SwitchTaskInput): Promise<CommandAck>
  }

  sessions: {
    create(input: CreateSessionInput): Promise<CommandAck>
    close(input: CloseSessionInput): Promise<CommandAck>
    /**
     * Switch a task's visible tab (§5.4). Routes through the loop so it can move
     * the persisted active-session pointer and broadcast `activeSessionChanged` —
     * the path that makes `Ctrl+Shift+Arrow` cross window boundaries (a task's
     * sessions can live in different windows). Every window receives the event, but
     * only the HOST window (`event.windowId`) moves its mark and raises itself; the
     * others keep their own marked tab and just apply the global ready-for-review clear.
     */
    switch(input: SwitchSessionInput): Promise<CommandAck>
    rename(input: RenameSessionInput): Promise<CommandAck>
    reorder(input: ReorderSessionInput): Promise<CommandAck>
    /** Reassign a session to another open window (V1.5, §3.7). */
    move(input: MoveSessionInput): Promise<CommandAck>
    /**
     * The session's live cwd → the path, or `null` if unresolvable (query, §6.5).
     * Powers "new terminal from this directory".
     */
    cwd(input: SessionCwdInput): Promise<string | null>
    /**
     * Fire-and-forget request to re-evaluate this session's state now (§5.4 R1).
     * No reply: the result surfaces as a `sessionStateChanged` event if it changed.
     */
    refreshState(input: RefreshSessionStateInput): void
    /**
     * Fire-and-forget report that a finished-turn session was watched IN PLACE (§9.5).
     * No reply: main broadcasts a `sessionSeen` event so every window's ready-for-review
     * view-model clears (the cross-window piece `markVisibleSessionSeen` can't reach).
     */
    markSeen(input: MarkSessionSeenInput): void
    /**
     * Fire-and-forget report that this session is now the focused window's marked tab
     * (§5.4, I10). Persist-only: main records it as the task's "last focused session";
     * no event, no window raise (use `switch` for a user-driven switch).
     */
    focus(input: FocusSessionInput): void
  }

  /**
   * Split-pane group commands (DESIGN §5.7). Unlike `sessions.focus`/`markSeen`,
   * these mutate the `Task` aggregate, so — like other mutating commands — each
   * resolves to a `CommandAck` and the result arrives as a `groupsChanged` event
   * (plus `sessionReordered` when membership changes order), not in the ack.
   */
  groups: {
    /** Join a session into the anchor's group next to its pane, forming one if lone. */
    join(input: JoinGroupInput): Promise<CommandAck>
    /** Remove a session from its group; it becomes lone. Dissolves a group of 2. */
    leave(input: LeaveGroupInput): Promise<CommandAck>
    /** Dissolve a group entirely; every member becomes lone, tabs stay in place. */
    ungroup(input: UngroupInput): Promise<CommandAck>
    /** Move a group's whole block of tabs so its first member lands at `toIndex`. */
    reorder(input: ReorderGroupInput): Promise<CommandAck>
    /** Set a group's split ratio at `path` (sent once, on drag release). */
    resize(input: ResizeGroupInput): Promise<CommandAck>
  }

  /** Multi-window control (V1.5, §5.6, §6.7). */
  windows: {
    /** Open a new secondary window; the ack carries its new `windowId`. */
    create(input: CreateWindowInput): Promise<CommandAck>
    /** Close a secondary window, deciding its live sessions' fate. */
    close(input: CloseWindowInput): Promise<CommandAck>
    /** Atomically open a new secondary window hosting a detached session. */
    createWithSession(input: CreateWindowWithSessionInput): Promise<CommandAck>
    /** Hit-test a screen point → the `windowId` under it, or `null` (query). */
    windowAtPoint(input: WindowAtPointInput): Promise<string | null>
  }

  pty: {
    /** Fire-and-forget keystrokes to a session's PTY. */
    write(input: PtyWriteInput): void
    /** Fire-and-forget resize (debounced in the renderer). */
    resize(input: PtyResizeInput): void
  }

  app: {
    /**
     * Full workspace snapshot for hydration on startup (§5.2). Resolves to a
     * {@link WindowedWorkspaceStateDTO} (V1.5): the base state plus this window's
     * identity and the window list. Pre-V1.5 callers reading only
     * {@link WorkspaceStateDTO} fields keep working (the type widens additively).
     */
    getState(): Promise<WindowedWorkspaceStateDTO>
    updateSettings(patch: SettingsPatchDTO): Promise<CommandAck>
    /**
     * This renderer's own window id (V1.5, §5.6). SYNCHRONOUS — the only
     * non-Promise method: preload reads `?windowId=` from the window URL, so no
     * IPC round-trip is needed. Defaults to `'main'` if the param is absent.
     */
    getWindowId(): string
    /**
     * The running app's release version (semver, e.g. `'1.0.0'`), for display in an
     * About affordance. Distinct from the feature-set version in `getState().version`.
     */
    getVersion(): Promise<string>
  }

  dialog: {
    /**
     * Open a native folder picker for the New-Task modal (§5.4). Resolves to the
     * chosen absolute directory path, or `undefined` if the user cancelled.
     */
    pickDirectory(): Promise<string | undefined>
  }

  /**
   * Configured projects (DESIGN §5.4, §6.3): repo roots kept in `settings.json`,
   * surfaced in the New-Task modal's sidebar. There is no store slice and no
   * `app:event` push — the modal fetches `list()` itself on open and after each
   * mutation.
   */
  projects: {
    /** All configured projects, each with its live task count. */
    list(): Promise<readonly ProjectListItemDTO[]>
    /**
     * Validate and add a project from a picked directory; a linked worktree
     * resolves to its main record (main checkout or bare dir) and an existing project is returned instead
     * of duplicated. The ack carries the resolved `project` on success.
     */
    add(input: AddProjectInput): Promise<CommandAck>
    /**
     * Remove a project. Rejected (`ok: false` + `error`) while any task still
     * belongs to it — the UI disables this ahead of time, but main re-checks.
     */
    remove(input: RemoveProjectInput): Promise<CommandAck>
    /** Set, or with an empty value clear, a project's default branch. */
    setDefaultBranch(input: SetProjectDefaultBranchInput): Promise<CommandAck>
    /** A project's main checkout + linked worktrees ("From Existing Repo" tab). */
    listWorktrees(input: ListProjectWorktreesInput): Promise<readonly ProjectWorktreeDTO[]>
  }

  /** OS clipboard access for terminal copy/paste (§5.4). */
  clipboard: {
    /** The clipboard's current plain text (empty string if none). */
    read(): Promise<string>
    /** Replace the clipboard's plain text. */
    write(text: string): Promise<void>
  }

  /**
   * Issues ("Issues", §13.4): locally-tracked work items, optionally bound 1:1 to a
   * task. There is no `issues.list`: the full set rides `app:getState().issues` and
   * stays current via `issueUpserted`/`issueDeleted` events, like `tasks`.
   */
  issues: {
    /** Create an issue; the ack carries the new `issueId`. */
    create(input: CreateIssueInput): Promise<CommandAck>
    /** Patch an issue (`projectPath: null` clears the project). */
    update(input: UpdateIssueInput): Promise<CommandAck>
    /** Delete an issue. Idempotent; leaves a bound task untouched. */
    delete(input: DeleteIssueInput): Promise<CommandAck>
    /**
     * Bind an issue to a task (1:1), replacing the issue's prior binding, if
     * any. Rejected (`CommandAck.error`) if the task is already linked to
     * a different issue (I19).
     */
    bind(input: BindIssueInput): Promise<CommandAck>
    /** Unbind an issue from its task. Status is unchanged. */
    unbind(input: UnbindIssueInput): Promise<CommandAck>
    /**
     * Fire-and-forget toggle of the Issues drawer. No reply: in the main window the
     * caller toggles its own store directly instead of calling this; a secondary
     * window calls it to raise the main window and relay the toggle there.
     */
    toggleDrawer(): void
  }

  /** Opening links outside the app ("Issues", §13.4): markdown descriptions, terminal web links. */
  shell: {
    /**
     * Open a URL in the system browser after checking it via `openExternalSafely`
     * (`toSafeExternalUrl`) main-side (defense in depth against a renderer-side bypass).
     * Resolves to whether it opened.
     */
    openExternal(input: OpenExternalInput): Promise<boolean>
  }

  /**
   * Jira import (DESIGN §13.7): manual, read-only fetch from the LiteLLM gateway, fed
   * to the Jira Import modal. `projects`/`sprints`/`search` are stateless queries that
   * bypass the command loop, like `dialog.pickDirectory`; `import` mutates (it creates
   * issues) and dispatches through the loop internally.
   */
  jira: {
    /** All Jira projects visible through the gateway, with their ticket counts. */
    projects(): Promise<JiraResultDTO<readonly JiraProjectDTO[]>>
    /** A project's sprints, ordered active → future → closed (discovered from search hits). */
    sprints(project: string): Promise<JiraResultDTO<readonly JiraSprintDTO[]>>
    /** One page of matching issues, each already classified against the workspace. */
    search(filters: JiraFiltersDTO, cursor?: string): Promise<JiraResultDTO<JiraSearchPageDTO>>
    /** Import the given keys as new Octopus issues; duplicates/conflicts are skipped. */
    import(input: ImportJiraIssuesInput): Promise<ImportJiraIssuesResultDTO>
  }

  /**
   * The Jira API key (DESIGN §13.7, I16). Backed by `CredentialsProvider`, encrypted
   * at rest via `safeStorage`. The key is set-only from the renderer's point of
   * view — it is NEVER read back; `hasJiraKey` exposes only its presence.
   */
  credentials: {
    /** Set (non-empty string) or clear (`null`) the Jira API key. */
    setJiraKey(input: SetJiraKeyInput): Promise<CommandAck>
    /** Whether a Jira API key is currently stored. Never the key itself. */
    hasJiraKey(): Promise<boolean>
  }

  /** Subscribe to the backend event stream; returns an unsubscribe fn (§5.2). */
  onEvent(handler: (event: EventDTO) => void): () => void
}
