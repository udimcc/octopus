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
/** Session-type identifier, resolved via the SessionTypeRegistry (§8). */
export type TypeId = Branded<string, 'TypeId'>

/** Tag a raw string as a {@link TaskId}. */
export const asTaskId = (raw: string): TaskId => raw as TaskId
/** Tag a raw string as a {@link SessionId}. */
export const asSessionId = (raw: string): SessionId => raw as SessionId
/** Tag a raw string as a {@link TypeId}. */
export const asTypeId = (raw: string): TypeId => raw as TypeId
