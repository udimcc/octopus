/**
 * Settings port (DESIGN §6.3, §6.4). Global settings live in a human-editable
 * `settings.json` sibling to the DB. Implemented by `JsonSettingsStore` in V1.
 *
 * Worktree provisioning no longer depends on global script paths — scripts are
 * repo-local (`<repoDir>/create_worktree.sh`, §6.4). The one worktree setting is
 * `worktree.location`: the base dir under which Octopus creates NATIVE worktrees
 * when a repo has no script (default `~/octopus_repos/`, resolved by the
 * composition root — never baked into a frozen constant).
 */

export interface WorktreeSettings {
  /**
   * Base dir for native (script-less) worktrees (§6.4). Empty string means
   * "unset" → the composition root substitutes the home-based default.
   */
  readonly location: string
}

export interface TerminalSettings {
  /** Preferred shell; else $SHELL, else /bin/bash (§6.1). */
  readonly shell?: string
}

export interface Settings {
  readonly worktree: WorktreeSettings
  readonly terminal: TerminalSettings
  /** Default session type for the New-Session dropdown (§5.4). */
  readonly defaultSessionTypeId: string
  /** Worktree create timeout override (ms); default 30 000 — script AND git (§6.4). */
  readonly worktreeCreateTimeoutMs?: number
}

/** A deep-partial patch for `save` (nested objects merged, not replaced). */
export interface SettingsPatch {
  readonly worktree?: Partial<WorktreeSettings>
  readonly terminal?: Partial<TerminalSettings>
  readonly defaultSessionTypeId?: string
  readonly worktreeCreateTimeoutMs?: number
}

export interface SettingsStore {
  /** Load settings, filling defaults for any missing keys. */
  load(): Settings
  /** Merge `patch` into the stored settings and persist; returns the result. */
  save(patch: SettingsPatch): Settings
}
