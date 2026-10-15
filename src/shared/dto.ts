/**
 * Renderer-facing data transfer objects (DESIGN §5.2, §6.5). These are the
 * ONLY types the renderer sees for backend data: the renderer TS project
 * (`tsconfig.web.json`) includes just `renderer` + `shared`, and the boundary
 * rule forbids the renderer (and the application layer) from importing `domain`
 * or `ports`. So the DTOs here structurally mirror the domain snapshots
 * (`src/domain/snapshots.ts`) but are declared independently.
 *
 * Lifecycle/state/typeId are plain `string`s on the wire (the domain enum VALUES
 * are exactly these strings, so `main`'s mapper assigns them with no cast). The
 * dormant `state` field is always `'unknown'` in V1 (§10) — carried so V2 can
 * populate it without a signature change.
 *
 * `main` owns the snapshot→DTO mapping (it is the only layer that may import both
 * `domain` and `shared`); keeping the two shapes in step is a tested seam
 * (`src/main/dto-mappers.test.ts`), not a shared import.
 */

/** Provenance of a script-provisioned worktree (mirror of ScriptInvocationMeta). */
export interface ScriptInvocationMetaDTO {
  readonly script: string
  readonly args: readonly string[]
  readonly repoRoot: string
  readonly provisionedAt: number
}

export interface WorktreeRefDTO {
  readonly path: string
  readonly branch?: string
  readonly baseRef?: string
  /** true = Octopus provisioned it (delete on removal); false = adopted, left on disk (§6.4). */
  readonly managed: boolean
  readonly provisionedBy: ScriptInvocationMetaDTO
}

/** Terminal session config on the wire (mirror of TerminalSessionConfig). */
export interface TerminalSessionConfigDTO {
  readonly kind: 'terminal'
  readonly shell?: string
  readonly initialCommand?: string
  readonly cwdOverride?: string
}

/** Discriminated on `kind`; V3 adds a `jenkins` member additively. */
export type SessionConfigDTO = TerminalSessionConfigDTO

export interface SessionDTO {
  readonly id: string
  readonly taskId: string
  readonly typeId: string
  readonly title: string
  readonly config: SessionConfigDTO
  /** Runtime lifecycle (`created`/`running`/`exited`/…). */
  readonly lifecycle: string
  /** V2+; always `'unknown'` in V1 (§10). */
  readonly state: string
  readonly order: number
  readonly createdAt: number
  readonly exitedAt?: number
  /** Which window renders this session (V1.5, §3.7). Defaults to `'main'`. */
  readonly windowId: string
}

export interface TaskDTO {
  readonly id: string
  readonly name: string
  /** Present once `Ready` (I1); absent while Provisioning/Failed, or a "No Repo" task. */
  readonly worktree?: WorktreeRefDTO
  /**
   * A "No Repo" task (§5.4): permanently `Ready` with NO worktree; its sessions
   * open at the home dir. Distinguishes an intentional repo-less task from the
   * transient worktree-less Provisioning state, and drives the "No Repository"
   * group in the Progress panel. Absent/`false` for ordinary tasks.
   */
  readonly repoLess?: boolean
  readonly lifecycle: string
  /** Always derived (I11); `'unknown'` in V1. */
  readonly state: string
  readonly sessions: readonly SessionDTO[]
  readonly activeSessionId?: string
  readonly position: number
  readonly createdAt: number
  /**
   * This task's split-pane groups (DESIGN §5.7), backend-owned (`Task` aggregate).
   * ALWAYS present — empty when the task has no grouped sessions — rather than
   * optional: the renderer never has to distinguish "not loaded yet" from "no
   * groups", so every reducer and selector treats it as a plain array. A session
   * is a member of at most one group (`GroupDTO.layout`'s leaves); a session
   * absent from every group is lone and shows alone (§3.7).
   */
  readonly groups: readonly GroupDTO[]
}

/**
 * One split-pane group (DESIGN §5.7): 2+ sessions of `TaskDTO`'s task, in one
 * window, with their own layout tree and a persisted color. `layout`'s leaves
 * ARE the membership — there is no separate member list. `colorIndex` indexes
 * the renderer's fixed group-color palette (`src/renderer/src/style/tokens.ts`,
 * added in a later wave); assigned once at group creation and stable until the
 * group dissolves.
 */
export interface GroupDTO {
  readonly id: string
  readonly layout: SplitNode
  readonly colorIndex: number
}

/** A session type as shown in the New-Session dropdown (§5.4, §8). */
export interface SessionTypeDTO {
  readonly typeId: string
  readonly displayName: string
  readonly icon: string
  readonly availableFromVersion: number
  /** JSON Schema for the config (drives the future config dialog, §8). */
  readonly configSchema: object
}

export interface SettingsDTO {
  readonly worktree: {
    /** Base dir for native worktrees; '' → the backend's home-based default. */
    readonly location: string
  }
  readonly terminal: {
    readonly shell?: string
    /** Session state detection (§9); default on. Applies to newly-created sessions. */
    readonly stateDetection?: boolean
    /** In-app status-change notifications (§9.5); default on. */
    readonly statusChangeNotifications?: boolean
  }
  readonly defaultSessionTypeId: string
  readonly worktreeCreateTimeoutMs?: number
  /** Group the task list by owning repo in the Progress panel (default true). */
  readonly groupTasksByRepo: boolean
  /**
   * Configurable chords, each bound independently (§5.4): cycle to the next /
   * previous session, move to the next / previous task, create a new session,
   * create a new task, close the active session, open terminal search, and copy /
   * paste the terminal selection.
   */
  readonly sessionNextKey?: string
  readonly sessionPrevKey?: string
  readonly taskNextKey?: string
  readonly taskPrevKey?: string
  readonly newSessionKey?: string
  readonly newTaskKey?: string
  readonly closeSessionKey?: string
  readonly searchKey?: string
  readonly copyKey?: string
  readonly pasteKey?: string
  /** Toggle the Issues drawer ("Issues", §13.5); default `'Alt+Shift+KeyI'`. */
  readonly issuesKey?: string
  /**
   * Split-pane chords (DESIGN §5.7), each bound independently like the chords
   * above: split the focused pane right / down with a new terminal, and move
   * pane focus left / right / up / down.
   */
  readonly splitRightKey?: string
  readonly splitDownKey?: string
  readonly focusPaneLeftKey?: string
  readonly focusPaneRightKey?: string
  readonly focusPaneUpKey?: string
  readonly focusPaneDownKey?: string
  /**
   * The Jira Import modal's last-used filters, prefilled on reopen (DESIGN §13.7).
   * Non-secret — the API key itself is NEVER stored here (it lives only in
   * `CredentialsProvider`, encrypted at rest).
   */
  readonly jira?: {
    readonly lastFilters?: JiraFiltersDTO
  }
}

/** A deep-partial settings patch (nested objects merged, not replaced). */
export interface SettingsPatchDTO {
  readonly worktree?: {
    readonly location?: string
  }
  readonly terminal?: {
    readonly shell?: string
    readonly stateDetection?: boolean
    readonly statusChangeNotifications?: boolean
  }
  readonly defaultSessionTypeId?: string
  readonly worktreeCreateTimeoutMs?: number
  readonly groupTasksByRepo?: boolean
  readonly sessionNextKey?: string
  readonly sessionPrevKey?: string
  readonly taskNextKey?: string
  readonly taskPrevKey?: string
  readonly newSessionKey?: string
  readonly newTaskKey?: string
  readonly closeSessionKey?: string
  readonly searchKey?: string
  readonly copyKey?: string
  readonly pasteKey?: string
  /** Toggle the Issues drawer ("Issues", §13.5); default `'Alt+Shift+KeyI'`. */
  readonly issuesKey?: string
  readonly splitRightKey?: string
  readonly splitDownKey?: string
  readonly focusPaneLeftKey?: string
  readonly focusPaneRightKey?: string
  readonly focusPaneUpKey?: string
  readonly focusPaneDownKey?: string
  /** Same shape as {@link SettingsDTO.jira}; merged, not replaced. Never the API key. */
  readonly jira?: {
    readonly lastFilters?: JiraFiltersDTO
  }
}

/** Full workspace snapshot for renderer hydration on startup (§5.2). */
export interface WorkspaceStateDTO {
  readonly tasks: readonly TaskDTO[]
  readonly activeTaskId?: string
  /** Available session types for the current app version (dropdown source). */
  readonly sessionTypes: readonly SessionTypeDTO[]
  readonly settings: SettingsDTO
  /** The app feature version (§10); the renderer uses it for version-gated UI. */
  readonly version: number
  /** All locally-tracked issues ("Issues", §13.1). No guaranteed order; the renderer sorts for display. */
  readonly issues: readonly IssueDTO[]
}

/**
 * Recursive split-pane layout tree (DESIGN §5.7 Split panes). A `leaf` names the
 * session shown in that pane; a `split` divides its area in two along `dir`
 * ('row' = children side by side, a left/b right — "split right"; 'col' =
 * stacked, a top/b bottom — "split down") at `ratio` (a's share, clamped
 * 0.1–0.9). This is now the layout of a backend-owned `GroupDTO` (above) rather
 * than an opaque per-window blob: the domain mutates its own tree type (it
 * cannot import `shared`) and `main`'s mapper translates to/from this shape at
 * the boundary. Geometry derived from a tree — boxes, neighbor lookup, the
 * minimum-size check, a drag's local ratio preview — stays a pure renderer
 * module (`renderer/src/store/split-layout.ts`); the renderer never mutates the
 * tree itself, it only sends `groups.resize`/`groups.join`/etc.
 */
export type SplitDirection = 'row' | 'col'

export type SplitNode =
  | { readonly kind: 'leaf'; readonly sessionId: string }
  | {
      readonly kind: 'split'
      readonly dir: SplitDirection
      readonly ratio: number
      readonly a: SplitNode
      readonly b: SplitNode
    }

/**
 * A root-to-split-node path within a {@link SplitNode} tree: 'a' or 'b' at each
 * level, identifying one split node (for `ResizeGroupInput.path`). Mirrors
 * `renderer/src/store/split-layout.ts`'s `SplitPath` exactly, declared here so
 * the renderer can eventually import this one instead of its own copy.
 */
export type SplitPath = readonly ('a' | 'b')[]

/** A window's role on the wire (window-view feature). Mirror of `WindowRecord.role`. */
export type WindowRole = 'main' | 'secondary' | 'view'

/** A persisted OS window on the wire (V1.5, §6.7). Mirror of `WindowRecord`. */
export interface WindowDTO {
  readonly id: string
  readonly role: WindowRole
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly createdAt: number
  /** Set only for `role: 'view'` — the task this view window is pinned to. */
  readonly taskId?: string
  /** Set only on a secondary of a VIEW: that view's id. Main's secondaries leave it unset. */
  readonly parentWindowId?: string
}

/**
 * The per-window hydration payload (V1.5, §5.6, §6.7). Extends
 * {@link WorkspaceStateDTO} with the identity of the window making the `getState`
 * call (`thisWindowId`/`thisWindowRole`, injected by `main` from `e.sender`) and
 * the full window list. Sessions in `tasks` are UNFILTERED; each renderer shows
 * only those whose `windowId === thisWindowId`. Additive: the base DTO is
 * unchanged, so pre-V1.5 consumers keep compiling.
 */
export interface WindowedWorkspaceStateDTO extends WorkspaceStateDTO {
  readonly thisWindowId: string
  readonly thisWindowRole: WindowRole
  readonly windows: readonly WindowDTO[]
  /**
   * Set only for a window created to show a detached session
   * (`windows.createWithSession`): the session this window should mark first on
   * hydrate, overriding the task's persisted focused session. One-shot: returned
   * by the window's first `getState` only — `main` deletes its registry entry
   * right after reading it, so a later re-hydrate (SettingsModal, or a renderer
   * crash-reload) does not replay the detach-time session.
   */
  readonly initialMark?: { readonly taskId: string; readonly sessionId: string }
  /**
   * Set for a `view` window AND for any secondary parented to one (window-view
   * feature): the task that window's GROUP is permanently pinned to. The renderer
   * keeps `activeTaskId` fixed to this value, ignoring `activeTaskChanged` events
   * (which the registry doesn't route to these windows anyway).
   */
  readonly viewTaskId?: string
}

// ── Projects (§5.4, §6.3) ──────────────────────────────────────────────────────

/**
 * A configured project: a repo root the user picked once, kept in `settings.json`
 * (DESIGN §6.3). `path` is always the repo's main record — its main checkout, or
 * the bare directory for a bare repo — `projects.add` resolves a linked worktree
 * to that main record before this is created.
 */
export interface ProjectDTO {
  readonly path: string
  readonly defaultBranch?: string
}

/** A project as listed in the New-Task modal sidebar, with its task count. */
export interface ProjectListItemDTO extends ProjectDTO {
  readonly taskCount: number
}

/** One entry of a project's `git worktree list` (main checkout or a linked worktree). */
export interface ProjectWorktreeDTO {
  readonly path: string
  readonly branch?: string
  /** Name of the task currently using this worktree, if any; drives the disabled row. */
  readonly usedByTaskName?: string
}

// ── Issues (§13.1, §6.3, "Issues") ────────────────────────────────────────────

/** An issue's workflow status on the wire (mirror of the domain `IssueStatus` enum). */
export type IssueStatusDTO = 'todo' | 'in_progress' | 'in_review' | 'done'

/** An issue's provenance on the wire (mirror of the domain `IssueSource` enum). */
export type IssueSourceDTO = 'local' | 'jira'

/**
 * A locally-tracked issue, optionally bound 1:1 to a task (`taskId`). The binding is
 * stored only on the issue (invariant I19); a task looks its issue up in reverse via
 * the renderer store's `issueForTask` selector. `description` is markdown, rendered by
 * `IssueMarkdown`. `projectPath` is `undefined` when the issue has no project, or when
 * its project was removed (`removeProject` clears it, leaving the issue itself intact).
 * `source` is read-only and never editable by the user; `jiraKey` is present only when
 * `source==='jira'` (Jira import, DESIGN §13.7).
 */
export interface IssueDTO {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly projectPath?: string
  readonly status: IssueStatusDTO
  readonly taskId?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly source: IssueSourceDTO
  readonly jiraKey?: string
}

// ── Jira import (DESIGN §13.7) ─────────────────────────────────────────────────

/** A Jira project, as listed by the gateway's project tool. */
export interface JiraProjectDTO {
  readonly key: string
  readonly ticketCount: number
}

/** A Jira sprint (there is no sprint tool; sprints are discovered from issue search hits). */
export interface JiraSprintDTO {
  readonly id: number
  readonly name: string
  readonly state: 'active' | 'future' | 'closed'
}

/**
 * The sprint filter in the Jira Import modal: either a known sprint picked from the
 * dropdown (`id`, with `name` carried along for display), or free text matched as a
 * case-insensitive substring when a project has no discoverable sprints.
 */
export type JiraSprintFilterDTO =
  | { readonly kind: 'id'; readonly id: number; readonly name: string }
  | { readonly kind: 'name'; readonly text: string }

/** Search filters for the Jira Import modal; also persisted as `settings.jira.lastFilters`. */
export interface JiraFiltersDTO {
  readonly project?: string
  readonly assignee?: string
  readonly issueKey?: string
  readonly days?: number
  readonly sprint?: JiraSprintFilterDTO
}

/**
 * How a fetched Jira issue compares to existing Octopus issues, by `jiraKey` then by
 * exact name/description match (mirror of the domain `JiraClassification`). `'new'`
 * carries nothing further; `'duplicate'`/`'conflict'` name the matched Octopus issue.
 */
export type JiraClassificationDTO =
  | { readonly kind: 'new' }
  | {
      readonly kind: 'duplicate' | 'conflict'
      readonly issueId: string
      readonly issueName: string
    }

/** One row of a Jira search result page, already classified against the workspace. */
export interface JiraIssueRowDTO {
  readonly key: string
  readonly summary: string
  readonly status: string
  readonly priority: string
  readonly type: string
  readonly assignee?: string
  readonly reporter?: string
  readonly created: string
  readonly sprintNames: readonly string[]
  readonly descriptionMarkdown: string
  readonly dodMarkdown: string
  readonly classification: JiraClassificationDTO
}

/** One page of a Jira search; `nextCursor` is absent on the last page. */
export interface JiraSearchPageDTO {
  readonly rows: readonly JiraIssueRowDTO[]
  readonly nextCursor?: string
  /**
   * The gateway's reported total match count for the filters, UNFILTERED by
   * `sprint` — passed through from the port's `JiraSearchPage.total` as-is even
   * when a sprint filter narrowed `rows` to fewer matches than this (the gateway
   * has no sprint filter of its own; the adapter filters client-side after
   * fetching).
   */
  readonly total: number
}

/**
 * A Jira-side error, carried as a value rather than thrown so its `kind` survives IPC
 * serialization (a thrown `Error` subclass loses its prototype across the bridge).
 * Mirror of the port's `JiraSourceError` kinds, plus `'invalid'` for input rejected
 * before any port call (`main/ipc-handlers.ts`'s validators).
 */
export interface JiraErrorDTO {
  readonly kind: 'noKey' | 'unauthorized' | 'unreachable' | 'gateway' | 'invalid'
  readonly message: string
}

/** Result envelope for the Jira queries, carrying `JiraErrorDTO` on failure. */
export type JiraResultDTO<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JiraErrorDTO }

/** Import the given Jira keys as new Octopus issues (Jira Import modal, "Import"). */
export interface ImportJiraIssuesInput {
  readonly keys: readonly string[]
}

/**
 * Result of `jira.import`. `importedCount` is how many issues were actually created;
 * `skippedKeys` lists keys not imported (already a Duplicate/Conflict by the time the
 * command loop re-classified, or a key Jira didn't return). `error` is set only when
 * the whole import failed before any issue was created.
 */
export interface ImportJiraIssuesResultDTO {
  readonly ok: boolean
  readonly importedCount: number
  readonly skippedKeys: readonly string[]
  readonly error?: JiraErrorDTO
}

/** Set (or, with `null`, clear) the Jira API key (Settings, "Jira API key"). */
export interface SetJiraKeyInput {
  readonly key: string | null
}

// ── Issue command inputs (UI → backend) ───────────────────────────────────────

/** Create an issue (Issues drawer, "+ New Issue"). `status` defaults to `'todo'`. */
export interface CreateIssueInput {
  readonly name: string
  readonly description: string
  readonly projectPath?: string
  readonly status?: IssueStatusDTO
}

/**
 * Patch an issue. All fields but `issueId` are optional (only provided fields change).
 * `projectPath: null` explicitly clears the project; `undefined`/omitted leaves it as is.
 */
export interface UpdateIssueInput {
  readonly issueId: string
  readonly name?: string
  readonly description?: string
  readonly projectPath?: string | null
  readonly status?: IssueStatusDTO
}

export interface DeleteIssueInput {
  readonly issueId: string
}

/**
 * Bind an issue to a task (1:1); replaces the issue's prior binding, if any.
 * Rejected if the task is already linked to a different issue (I19).
 */
export interface BindIssueInput {
  readonly issueId: string
  readonly taskId: string
}

export interface UnbindIssueInput {
  readonly issueId: string
}

/** Open a URL in the system browser (markdown links, terminal web links). */
export interface OpenExternalInput {
  readonly url: string
}

// ── Command inputs (UI → backend) ─────────────────────────────────────────────

/**
 * Create a task by provisioning a BRAND-NEW worktree (New-Task modal, "From New
 * Worktree" tab, §5.4). Octopus runs the repo-local create script / native git.
 */
export interface CreateTaskFromNewInput {
  readonly mode: 'new'
  readonly name: string
  /** The chosen repository directory — the path of the selected project (§5.4). */
  readonly repoDir: string
  /** Branch to create the worktree FROM (editable; `master` placeholder). */
  readonly sourceBranch: string
  /** Branch to create the worktree ON (prefilled slug the user may edit). */
  readonly newBranch: string
  /**
   * The issue picked in the New-Task modal to bind this task to, once it
   * reaches Ready ("Issues", §13.3). If the issue is gone, or already
   * connected to a different task, by the time this task becomes Ready, the
   * task is still created — unbound — and an `error` toast explains why.
   */
  readonly issueId?: string
}

/**
 * Create a task by ADOPTING an existing repository directory (New-Task modal,
 * "From Existing Repo" tab). Octopus detects the directory's owning repo and
 * branch via git (the repo's main checkout is allowed) instead of provisioning
 * anything, and marks the worktree `managed: false` so delete leaves it on disk.
 */
export interface CreateTaskFromExistingInput {
  readonly mode: 'existing'
  readonly name: string
  /** The existing worktree directory, picked from the selected project's worktree list (§5.4). */
  readonly worktreeDir: string
  /**
   * The issue picked in the New-Task modal to bind this task to, once it
   * reaches Ready ("Issues", §13.3). If the issue is gone, or already
   * connected to a different task, by the time this task becomes Ready, the
   * task is still created — unbound — and an `error` toast explains why.
   */
  readonly issueId?: string
}

/**
 * Create a "No Repo" task (New-Task modal, "No Repo" tab, §5.4): no worktree,
 * nothing provisioned or touched on disk. Its sessions open at the home dir with
 * no `cd`. Only a name is needed — for ad-hoc work (checking mounts, `less` on a
 * log, editing a config file) unrelated to any repo.
 */
export interface CreateTaskFromNoneInput {
  readonly mode: 'none'
  readonly name: string
  /**
   * The issue picked in the New-Task modal to bind this task to; since this
   * mode becomes Ready synchronously (no provisioning step), the bind check
   * runs immediately. If the issue is gone, or already linked to a
   * different task, the task is still created — unbound — and an `error`
   * toast explains why.
   */
  readonly issueId?: string
}

/**
 * Discriminated on `mode`: provision a new worktree, adopt an existing one, or
 * create a repo-less "No Repo" task.
 */
export type CreateTaskInput =
  CreateTaskFromNewInput | CreateTaskFromExistingInput | CreateTaskFromNoneInput

export interface DeleteTaskInput {
  readonly taskId: string
  /** Force-forget a Stale/DeleteFailed task without re-running the script (I4). */
  readonly force?: boolean
  /** The user acknowledged uncommitted changes in the dirty-confirm dialog. */
  readonly confirmedDirty?: boolean
  /**
   * Also delete this task's bound issue ("Delete both", "Issues" §13.3). Applied only in
   * the final delete step, after the task itself is actually removed.
   */
  readonly alsoDeleteIssue?: boolean
}

export interface RenameTaskInput {
  readonly taskId: string
  readonly name: string
}

export interface ReorderTaskInput {
  readonly taskId: string
  readonly toIndex: number
}

export interface SwitchTaskInput {
  readonly taskId: string
}

export interface CreateSessionInput {
  readonly taskId: string
  /** Session type id; omitted → the workspace default (§5.4). */
  readonly typeId?: string
  /** Optional title; omitted → a generated default. */
  readonly title?: string
  /** Optional config; omitted → the provider's `defaultConfig(worktree)` (§8). */
  readonly config?: SessionConfigDTO
  /**
   * Split intent (DESIGN §5.7): create the session already joined into
   * `anchorSessionId`'s group, next to its pane, along `dir` — forming a new
   * group if the anchor is currently lone. Lets the split shortcuts create the
   * terminal and join it in one command, instead of create-then-join as two
   * round trips with a renderer-held "pending split" in between.
   */
  readonly split?: {
    readonly anchorSessionId: string
    readonly dir: SplitDirection
  }
}

export interface CloseSessionInput {
  readonly sessionId: string
}

/** Switch a task's visible tab (§5.4); wire mirror of the application command. */
export interface SwitchSessionInput {
  readonly sessionId: string
}

/**
 * Persist that this session is now the FOCUSED window's marked tab (§5.4, I10;
 * fire-and-forget). Persist-only: moves the task's stored "last focused session"
 * pointer and nothing else — no event, no window raise. Wire mirror of the
 * application command.
 */
export interface FocusSessionInput {
  readonly sessionId: string
}

export interface RenameSessionInput {
  readonly sessionId: string
  readonly title: string
}

/** Query a session's live current working directory (§6.5, "new terminal here"). */
export interface SessionCwdInput {
  readonly sessionId: string
}

/** Ask a session to manually re-evaluate its state now (§5.4 R1, fire-and-forget). */
export interface RefreshSessionStateInput {
  readonly sessionId: string
}

/**
 * Report that a finished-turn session was WATCHED IN PLACE (§9.5, fire-and-forget).
 * The hosting window sends this when its `markVisibleSessionSeen` clears a session's
 * "unseen finished turn" flag, so main can broadcast the clear to every window — the
 * main window's task rollup folds over sessions in ANY window but can't see another
 * window's focus, so a watch-in-place seen there needs relaying.
 */
export interface MarkSessionSeenInput {
  readonly sessionId: string
}

export interface ReorderSessionInput {
  readonly taskId: string
  readonly sessionId: string
  readonly toIndex: number
}

// ── Group command inputs (DESIGN §5.7) ────────────────────────────────────────

/**
 * Join `sessionId` into `anchorSessionId`'s group, next to its pane, along `dir`
 * (forming a new group if the anchor is currently lone). If `sessionId` already
 * belongs to another group it leaves that group first (dissolving it if that
 * drops it to 1 member) — a session is in at most one group.
 */
export interface JoinGroupInput {
  readonly sessionId: string
  readonly anchorSessionId: string
  readonly dir: SplitDirection
}

/**
 * Remove `sessionId` from its group; it becomes lone again, its tab placed
 * right after the group. A group left with one member dissolves. `sessionId`
 * must currently be in a group — the backend's `Task.leave` throws
 * `InvariantViolationError` otherwise, which the command loop turns into
 * `{ ok: false }` rather than a no-op (see `application/use-cases/leave-group.ts`).
 */
export interface LeaveGroupInput {
  readonly sessionId: string
}

/** Dissolve `groupId` entirely: every member becomes lone, tabs stay in place. */
export interface UngroupInput {
  readonly taskId: string
  readonly groupId: string
}

/**
 * Move `groupId`'s whole block of member tabs so its first member lands at
 * `toIndex` in the task's full session order (members stay contiguous and in
 * their existing relative order).
 */
export interface ReorderGroupInput {
  readonly taskId: string
  readonly groupId: string
  readonly toIndex: number
}

/** Set the ratio of `groupId`'s split node at `path` (sent once, on drag release). */
export interface ResizeGroupInput {
  readonly taskId: string
  readonly groupId: string
  readonly path: SplitPath
  readonly ratio: number
}

// ── Window command inputs (V1.5, §5.6, §6.7) ──────────────────────────────────

/** Pixel geometry on the wire (V1.5). Mirror of the application `WindowBounds`. */
export interface WindowBoundsDTO {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Open a new secondary window (V1.5). `bounds` omitted → OS default placement. */
export interface CreateWindowInput {
  readonly bounds?: WindowBoundsDTO
}

/** Close a secondary window, deciding its live sessions' fate (V1.5, §6.7). */
export interface CloseWindowInput {
  readonly windowId: string
  readonly disposition: 'move-to-main' | 'kill-sessions'
}

/** Reassign a session to another open window (V1.5, §3.7). */
export interface MoveSessionInput {
  readonly sessionId: string
  readonly targetWindowId: string
}

/** Atomically open a new secondary window hosting a detached session (V1.5). */
export interface CreateWindowWithSessionInput {
  readonly sessionId: string
  readonly bounds?: WindowBoundsDTO
}

/**
 * A screen-space point to hit-test against open windows (V1.5, §6.7). The
 * detach-drop gesture asks `windows.windowAtPoint` which window (if any) sits under
 * the pointer on release.
 */
export interface WindowAtPointInput {
  readonly x: number
  readonly y: number
}

// ── View command inputs (window-view feature) ─────────────────────────────────

/** Pop a task into its own dedicated window (right-click a task row, "New Window From Task"). */
export interface CreateViewInput {
  readonly taskId: string
}

/** Close a view window, returning its sessions (and its secondaries') to main. */
export interface CloseViewInput {
  readonly windowId: string
}

// ── Project command inputs (UI → backend) ─────────────────────────────────────

/** Add a project from a picked directory (New-Task modal, "+ Add project"). */
export interface AddProjectInput {
  readonly dir: string
}

/** Remove a project; rejected (`ok: false`) while any task still belongs to it. */
export interface RemoveProjectInput {
  readonly path: string
}

/** Set (or, with an empty value, clear) a project's auto-detected default branch. */
export interface SetProjectDefaultBranchInput {
  readonly path: string
  readonly defaultBranch?: string
}

/** List a project's main checkout + linked worktrees (New-Task modal, "Existing Repo"). */
export interface ListProjectWorktreesInput {
  readonly projectPath: string
}

/**
 * Result of a command (mirror of the application's `CommandResult`). `ok=false`
 * with `needsDirtyConfirm` is the delete-task dirty gate: the UI shows the
 * "delete anyway?" dialog and re-dispatches with `confirmedDirty: true` (§6.6).
 */
export interface CommandAck {
  readonly ok: boolean
  readonly needsDirtyConfirm?: boolean
  readonly error?: string
  /** Id of a window created by `windows.create`/`windows.createWithSession` (V1.5). */
  readonly windowId?: string
  /** Resolved project returned by `projects.add`. */
  readonly project?: ProjectDTO
  /** Id of an issue created by `issues.create` ("Issues", §13.3). */
  readonly issueId?: string
}
