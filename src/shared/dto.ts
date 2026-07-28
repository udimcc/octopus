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
  /** Present once `Ready` (I1); absent while Provisioning/Failed. */
  readonly worktree?: WorktreeRefDTO
  readonly lifecycle: string
  /** Always derived (I11); `'unknown'` in V1. */
  readonly state: string
  readonly sessions: readonly SessionDTO[]
  readonly activeSessionId?: string
  readonly position: number
  readonly createdAt: number
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
  }
  readonly defaultSessionTypeId: string
  readonly worktreeCreateTimeoutMs?: number
  /**
   * Configurable chords, each bound independently (§5.4): cycle to the next /
   * previous session, move to the next / previous task, create a new session,
   * create a new task, close the active session, and open terminal search.
   */
  readonly sessionNextKey?: string
  readonly sessionPrevKey?: string
  readonly taskNextKey?: string
  readonly taskPrevKey?: string
  readonly newSessionKey?: string
  readonly newTaskKey?: string
  readonly closeSessionKey?: string
  readonly searchKey?: string
}

/** A deep-partial settings patch (nested objects merged, not replaced). */
export interface SettingsPatchDTO {
  readonly worktree?: {
    readonly location?: string
  }
  readonly terminal?: {
    readonly shell?: string
  }
  readonly defaultSessionTypeId?: string
  readonly worktreeCreateTimeoutMs?: number
  readonly sessionNextKey?: string
  readonly sessionPrevKey?: string
  readonly taskNextKey?: string
  readonly taskPrevKey?: string
  readonly newSessionKey?: string
  readonly newTaskKey?: string
  readonly closeSessionKey?: string
  readonly searchKey?: string
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
}

/** A persisted OS window on the wire (V1.5, §6.7). Mirror of `WindowRecord`. */
export interface WindowDTO {
  readonly id: string
  readonly role: 'main' | 'secondary'
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly createdAt: number
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
  readonly thisWindowRole: 'main' | 'secondary'
  readonly windows: readonly WindowDTO[]
}

// ── Command inputs (UI → backend) ─────────────────────────────────────────────

/**
 * Create a task by provisioning a BRAND-NEW worktree (New-Task modal, "From New
 * Worktree" tab, §5.4). Octopus runs the repo-local create script / native git.
 */
export interface CreateTaskFromNewInput {
  readonly mode: 'new'
  readonly name: string
  /** The chosen repository directory (from the native folder picker, §5.4). */
  readonly repoDir: string
  /** Branch to create the worktree FROM (editable; `master` placeholder). */
  readonly sourceBranch: string
  /** Branch to create the worktree ON (prefilled slug the user may edit). */
  readonly newBranch: string
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
  /** The existing worktree directory the user picked (native folder picker). */
  readonly worktreeDir: string
}

/** Discriminated on `mode`: provision a new worktree or adopt an existing one. */
export type CreateTaskInput = CreateTaskFromNewInput | CreateTaskFromExistingInput

export interface DeleteTaskInput {
  readonly taskId: string
  /** Force-forget a Stale/DeleteFailed task without re-running the script (I4). */
  readonly force?: boolean
  /** The user acknowledged uncommitted changes in the dirty-confirm dialog. */
  readonly confirmedDirty?: boolean
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
}

export interface CloseSessionInput {
  readonly sessionId: string
}

export interface RenameSessionInput {
  readonly sessionId: string
  readonly title: string
}

export interface ReorderSessionInput {
  readonly taskId: string
  readonly sessionId: string
  readonly toIndex: number
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
}
