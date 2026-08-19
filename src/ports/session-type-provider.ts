/**
 * Session-type registry (DESIGN §8). Separates BEHAVIOR (this provider,
 * domain-facing) from RENDERING (the renderer's `SessionViewFactory`, keyed by
 * the same `typeId`). The New-Session dropdown is populated purely from the
 * registry, filtered by `availableFromVersion ≤ currentVersion` (§5.4).
 *
 * Adding a type (Jenkins in V3) is a new provider registered at the composition
 * root — zero edits to `Task`, the aggregator, or the dropdown (§8 acceptance
 * test). `capabilities` carries the `EvaluatesState` seam (off for Terminal in
 * V1, §10).
 */

import type { TypeId } from '../domain/ids'
import type { SessionConfig } from '../domain/session-config'
import type { SessionManager, SessionRuntime, SessionRuntimeContext } from './session-runtime'

/** Declarative capabilities a session type may have (§8). */
export enum Capability {
  /** The type produces `sessionStateChanged` signals. OFF for Terminal in V1 (§10). */
  EvaluatesState = 'evaluates_state'
}

export interface SessionTypeProvider {
  readonly typeId: TypeId
  readonly displayName: string
  /** Icon identifier for the dropdown/tab (renderer resolves the actual glyph). */
  readonly icon: string
  /** Minimum app version this type is available from (§5.4 dropdown filter). */
  readonly availableFromVersion: number
  /** JSON Schema for `SessionConfig`, driving validation + the New-Session dialog (§8). */
  readonly configSchema: object
  /** Declarative capability set (§8); empty for Terminal in V1. */
  readonly capabilities: ReadonlySet<Capability>

  /**
   * Default config for a new session in the given worktree (§8, §3.2). When
   * `worktreePath` is omitted (a "No Repo" task, §5.4), the returned config carries
   * no cwd override, so the runtime opens the session at the home dir.
   */
  defaultConfig(worktreePath?: string): SessionConfig

  /** Create a (not-yet-started) runtime for a session (§8 factory). */
  createRuntime(manager: SessionManager, ctx: SessionRuntimeContext): SessionRuntime
}

export interface SessionTypeRegistry {
  register(provider: SessionTypeProvider): void
  get(typeId: TypeId): SessionTypeProvider | undefined
  /** All providers with `availableFromVersion ≤ version` (dropdown source, §5.4). */
  available(version: number): readonly SessionTypeProvider[]
}
