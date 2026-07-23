/**
 * `updateSettings` use case (DESIGN §6.3, §5.4). Merges a patch into the stored
 * settings (the store deep-merges + persists) and keeps the domain `Workspace`
 * config in sync: `defaultSessionTypeId` lives in both places — `settings.json`
 * (durable) and the in-memory `WorkspaceConfig` (what `openSession` reads for the
 * default type). Emits nothing over the bus; the renderer refetches state or the
 * change is inert until the next New-Session.
 *
 * The application `SettingsPatch` is structurally the port's `SettingsPatch`, so
 * it is forwarded directly (both are transport-agnostic, application-layer types).
 */

import type { AppDependencies } from '../dependencies'
import type { SettingsPatch } from '../commands'

export function updateSettings(deps: AppDependencies, patch: SettingsPatch): void {
  const next = deps.settings.save(patch)
  // Mirror the default session type into the workspace config so subsequent
  // `openSession` calls pick it up without reloading the store (§5.4).
  deps.workspace.updateConfig({ defaultSessionTypeId: next.defaultSessionTypeId })
}
