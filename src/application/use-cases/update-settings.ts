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
 *
 * The application `SettingsPatch` (`commands.ts`) deliberately has no `projects`
 * field — projects change only through the dedicated, validated `addProject` /
 * `removeProject` / `setProjectDefaultBranch` commands (§6.3). But `main`'s
 * `updateSettings` IPC handler forwards the renderer's raw patch object as-is, so
 * at RUNTIME a stray `projects` key could still ride along despite the type.
 * Strip it defensively before saving, so the generic settings path can never be
 * used to bypass that validation.
 */

import type { AppDependencies } from '../dependencies'
import type { SettingsPatch } from '../commands'

export function updateSettings(deps: AppDependencies, patch: SettingsPatch): void {
  const safePatch = { ...patch } as SettingsPatch & { projects?: unknown }
  delete safePatch.projects
  const next = deps.settings.save(safePatch as SettingsPatch)
  // Mirror the default session type into the workspace config so subsequent
  // `openSession` calls pick it up without reloading the store (§5.4).
  deps.workspace.updateConfig({ defaultSessionTypeId: next.defaultSessionTypeId })
}
