/**
 * The `Command` set the single-writer loop accepts (DESIGN §6.5 commands, §6.6).
 * These are the APPLICATION-level shapes: they use domain-branded ids and the
 * domain `SessionConfig`, NOT the wire DTOs — the boundary rule forbids the
 * application from importing `shared`. `main`'s `ipc-handlers` maps each inbound
 * DTO to one of these before dispatching.
 *
 * `ingestSessionState` is the §10 V1 seam: a dormant command a V2 state provider
 * will dispatch to recompute `TaskState`. Defined now, dispatched by nobody.
 */

import type { TaskId, SessionId, TypeId, WindowId } from '../domain/ids'
import type { SessionConfig } from '../domain/session-config'
import type { SessionState } from '../domain/state'

/** Provision a brand-new worktree (New-Task modal "From New Worktree", §5.4). */
export interface CreateTaskFromNewInput {
  readonly mode: 'new'
  readonly name: string
  /** The task's chosen repository directory (New-Task modal, §5.4). */
  readonly repoDir: string
  /** Branch to create the worktree FROM. */
  readonly sourceBranch: string
  /** Branch to create the worktree ON. */
  readonly newBranch: string
}

/** Adopt an existing worktree directory (New-Task modal "From Existing Worktree"). */
export interface CreateTaskFromExistingInput {
  readonly mode: 'existing'
  readonly name: string
  /** The existing worktree directory the user picked. */
  readonly worktreeDir: string
}

/** Discriminated on `mode`: provision a new worktree or adopt an existing one. */
export type CreateTaskInput = CreateTaskFromNewInput | CreateTaskFromExistingInput

export interface DeleteTaskInput {
  readonly taskId: TaskId
  readonly force?: boolean
  readonly confirmedDirty?: boolean
}

export interface RenameTaskInput {
  readonly taskId: TaskId
  readonly name: string
}

export interface ReorderTaskInput {
  readonly taskId: TaskId
  readonly toIndex: number
}

export interface SwitchTaskInput {
  readonly taskId: TaskId
}

export interface CreateSessionInput {
  readonly taskId: TaskId
  readonly typeId?: TypeId
  readonly title?: string
  readonly config?: SessionConfig
  /** Which window hosts the new session (V1.5, §6.7). Omitted → main window. */
  readonly windowId?: WindowId
}

export interface CloseSessionInput {
  readonly sessionId: SessionId
}

export interface RenameSessionInput {
  readonly sessionId: SessionId
  readonly title: string
}

export interface ReorderSessionInput {
  readonly taskId: TaskId
  readonly sessionId: SessionId
  readonly toIndex: number
}

export interface WriteToPtyInput {
  readonly sessionId: SessionId
  readonly data: string
}

export interface ResizePtyInput {
  readonly sessionId: SessionId
  readonly cols: number
  readonly rows: number
}

export interface SettingsPatch {
  readonly worktree?: {
    readonly location?: string
  }
  readonly terminal?: {
    readonly shell?: string
  }
  readonly defaultSessionTypeId?: string
  readonly worktreeCreateTimeoutMs?: number
}

/** A session's runtime died spontaneously (§6.1). Routed back through the loop. */
export interface HandleRuntimeExitInput {
  readonly sessionId: SessionId
  readonly exitCode?: number
  readonly signal?: number
}

/** §10 V1 seam: a runtime state signal ingested by the loop (V2). Dormant. */
export interface IngestSessionStateInput {
  readonly sessionId: SessionId
  readonly state: SessionState
}

/** Pixel geometry for a new OS window (V1.5, §6.7). Optional → OS default placement. */
export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Open a new secondary window (V1.5, §6.7). `role` is always `secondary` — the
 * single main window is created at boot, never via a command. `bounds` seeds the
 * OS window position (e.g. the drop point of a detached tab); omitted → OS default.
 */
export interface CreateWindowInput {
  readonly role: 'secondary'
  readonly bounds?: WindowBounds
}

/**
 * Close a secondary window (V1.5, §6.7). `disposition` decides its live sessions:
 * `move-to-main` reassigns each to the main window; `kill-sessions` closes each.
 * The renderer resolves this via the OS close dialog before dispatching.
 */
export interface CloseWindowInput {
  readonly windowId: WindowId
  readonly disposition: 'move-to-main' | 'kill-sessions'
}

/** Reassign a session to another (already-open) window (V1.5, §3.7, §6.7). */
export interface MoveSessionToWindowInput {
  readonly sessionId: SessionId
  readonly targetWindowId: WindowId
}

/**
 * Atomically open a new secondary window and move a session into it (V1.5, §6.7).
 * The detach-onto-empty-desktop gesture: one dispatch emits `windowCreated` then
 * `sessionMovedToWindow`, so no intermediate empty-window state races the drop.
 */
export interface CreateWindowWithSessionInput {
  readonly sessionId: SessionId
  readonly bounds?: WindowBounds
}

/**
 * The command union. Discriminated on `kind`; the loop's `switch` is exhaustive.
 * `ingestSessionState` is present but never dispatched in V1 (§10).
 */
export type Command =
  | { readonly kind: 'createTask'; readonly input: CreateTaskInput }
  | { readonly kind: 'deleteTask'; readonly input: DeleteTaskInput }
  | { readonly kind: 'switchTask'; readonly input: SwitchTaskInput }
  | { readonly kind: 'renameTask'; readonly input: RenameTaskInput }
  | { readonly kind: 'reorderTask'; readonly input: ReorderTaskInput }
  | { readonly kind: 'createSession'; readonly input: CreateSessionInput }
  | { readonly kind: 'closeSession'; readonly input: CloseSessionInput }
  | { readonly kind: 'renameSession'; readonly input: RenameSessionInput }
  | { readonly kind: 'reorderSession'; readonly input: ReorderSessionInput }
  | { readonly kind: 'writeToPty'; readonly input: WriteToPtyInput }
  | { readonly kind: 'resizePty'; readonly input: ResizePtyInput }
  | { readonly kind: 'updateSettings'; readonly input: SettingsPatch }
  | { readonly kind: 'handleRuntimeExit'; readonly input: HandleRuntimeExitInput }
  | { readonly kind: 'ingestSessionState'; readonly input: IngestSessionStateInput }
  | { readonly kind: 'createWindow'; readonly input: CreateWindowInput }
  | { readonly kind: 'closeWindow'; readonly input: CloseWindowInput }
  | { readonly kind: 'moveSessionToWindow'; readonly input: MoveSessionToWindowInput }
  | { readonly kind: 'createWindowWithSession'; readonly input: CreateWindowWithSessionInput }

/**
 * Result of a command. `ok=false` + `needsDirtyConfirm` is the delete-task dirty
 * gate (§6.6): the UI shows "delete anyway?" and re-dispatches with
 * `confirmedDirty: true`.
 */
export interface CommandResult {
  readonly ok: boolean
  readonly needsDirtyConfirm?: boolean
  readonly error?: string
  /**
   * The id of a window just created by `createWindow`/`createWindowWithSession`
   * (V1.5, §6.7). `main` needs it to open the OS `BrowserWindow` for the new id.
   */
  readonly windowId?: WindowId
}
