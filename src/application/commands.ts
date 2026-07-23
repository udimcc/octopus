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

import type { TaskId, SessionId, TypeId } from '../domain/ids'
import type { SessionConfig } from '../domain/session-config'
import type { SessionState } from '../domain/state'

export interface CreateTaskInput {
  readonly name: string
  /** The task's chosen repository directory (New-Task modal, §5.4). */
  readonly repoDir: string
  /** Branch to create the worktree FROM. */
  readonly sourceBranch: string
  /** Branch to create the worktree ON. */
  readonly newBranch: string
}

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

/**
 * Result of a command. `ok=false` + `needsDirtyConfirm` is the delete-task dirty
 * gate (§6.6): the UI shows "delete anyway?" and re-dispatches with
 * `confirmedDirty: true`.
 */
export interface CommandResult {
  readonly ok: boolean
  readonly needsDirtyConfirm?: boolean
  readonly error?: string
}
