/**
 * `getState` read-model query (DESIGN §5.2). Assembles everything the renderer
 * needs to hydrate on startup: the full workspace snapshot, the session types
 * available at the current version (the New-Session dropdown source, §5.4), the
 * effective settings, and the app version.
 *
 * It returns an application-level VIEW built from domain snapshots + port types —
 * NOT the wire `WorkspaceStateDTO`, because the boundary rule forbids the
 * application from importing `shared`. `main` maps this view to the DTO (it is the
 * only layer that may import both `domain`/application and `shared`); the mapping
 * is a tested seam (`src/main/dto-mappers.test.ts`), not a shared import.
 *
 * Session-type providers carry functions (`createRuntime`), so they are projected
 * to a plain, serializable `SessionTypeView` here — the query never leaks a live
 * provider past the application boundary.
 *
 * **Issues ("Issues" §13.3, I19).** No extra wiring needed here: `issues` already
 * rides along inside `workspace` — `Workspace.toSnapshot` includes
 * `issues: this.issues().map((i) => i.toSnapshot())` (`src/domain/workspace.ts`),
 * so `AppStateView.workspace.issues` is populated for every `getState` call.
 * `main`'s DTO mapper is the one responsible for projecting that array onto the
 * wire `WorkspaceStateDTO`.
 */

import type { AppDependencies } from '../dependencies'
import type { WorkspaceSnapshot } from '../../domain/snapshots'
import type { Settings } from '../../ports/settings-store'
import type { WindowRecord } from '../../ports/workspace-persistence'

/** A session type projected to serializable metadata (no `createRuntime` fn). */
export interface SessionTypeView {
  readonly typeId: string
  readonly displayName: string
  readonly icon: string
  readonly availableFromVersion: number
  readonly configSchema: object
}

/** The application's assembled read-model; `main` maps it to `WorkspaceStateDTO`. */
export interface AppStateView {
  readonly workspace: WorkspaceSnapshot
  readonly sessionTypes: readonly SessionTypeView[]
  readonly settings: Settings
  readonly version: number
  /**
   * Every persisted OS window (V1.5, §6.7). Sessions are returned UNFILTERED in
   * `workspace`; each renderer filters them by its own `windowId` (injected at the
   * DTO boundary in `main`, not here — this pure query has no per-window notion).
   */
  readonly windows: readonly WindowRecord[]
}

export function getState(deps: AppDependencies): AppStateView {
  const workspace = deps.workspace.toSnapshot(deps.aggregator)

  const sessionTypes: SessionTypeView[] = deps.registry.available(deps.currentVersion).map((p) => ({
    typeId: p.typeId,
    displayName: p.displayName,
    icon: p.icon,
    availableFromVersion: p.availableFromVersion,
    configSchema: p.configSchema
  }))

  return {
    workspace,
    sessionTypes,
    settings: deps.settings.load(),
    version: deps.currentVersion,
    windows: deps.persistence.loadWindows()
  }
}
