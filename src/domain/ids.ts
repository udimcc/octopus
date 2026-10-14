/**
 * Branded identifier types (DESIGN §3.1). Cross-aggregate references are by id
 * only, never object pointers, so ids flow through persistence, events and any
 * future multi-window refactor cleanly. Branding makes a `TaskId` structurally
 * incompatible with a `SessionId` at compile time even though both are strings
 * at runtime — passing the wrong id is a type error, not a silent bug.
 */

declare const brand: unique symbol

type Branded<T, B> = T & { readonly [brand]: B }

/** Globally unique task identifier (I6). */
export type TaskId = Branded<string, 'TaskId'>
/** Globally unique session identifier (I5) — needs no task context to route. */
export type SessionId = Branded<string, 'SessionId'>
/** Globally unique issue identifier (I19). */
export type IssueId = Branded<string, 'IssueId'>
/** Session-type identifier, resolved via the SessionTypeRegistry (§8). */
export type TypeId = Branded<string, 'TypeId'>
/**
 * Identifier of an OS window (V1.5, DESIGN §3.7). A window is a
 * presentation/persistence concept, not a domain aggregate — this id is only an
 * opaque tag on `Session` saying which window currently renders it. Bounds and
 * role live in persistence/main, never in the pure domain.
 */
export type WindowId = Branded<string, 'WindowId'>
/**
 * Identifier of a split group (DESIGN §5.7): 2+ sessions of one task in one
 * window sharing a layout tree and a color. Opaque — membership is the tree's
 * leaves, not this id; it only names the group for commands/events/persistence.
 */
export type GroupId = Branded<string, 'GroupId'>

/** Tag a raw string as a {@link TaskId}. */
export const asTaskId = (raw: string): TaskId => raw as TaskId
/** Tag a raw string as a {@link SessionId}. */
export const asSessionId = (raw: string): SessionId => raw as SessionId
/** Tag a raw string as an {@link IssueId}. */
export const asIssueId = (raw: string): IssueId => raw as IssueId
/** Tag a raw string as a {@link TypeId}. */
export const asTypeId = (raw: string): TypeId => raw as TypeId
/** Tag a raw string as a {@link WindowId}. */
export const asWindowId = (raw: string): WindowId => raw as WindowId
/** Tag a raw string as a {@link GroupId}. */
export const asGroupId = (raw: string): GroupId => raw as GroupId

/**
 * The stable id of the single main window (V1.5, DESIGN §3.7). Sessions default
 * to this at creation, and a session whose window record is gone falls back to
 * it (I18). A named constant, not a magic `null`, so it round-trips persistence.
 */
export const MAIN_WINDOW_ID: WindowId = asWindowId('main')
