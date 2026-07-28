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
  /**
   * Which session backend hosts PTYs (§6.2). `'daemon'` (default when unset) hosts
   * them in the out-of-process `octopusd`, so they survive an app restart and a
   * restart RE-ATTACHES (carrying cwd, live programs, scrollback). `'in-process'`
   * spawns them inside the Electron main process (V1 behavior — killed on app quit),
   * an explicit opt-out for anyone who needs it. Rollback is a one-line setting flip.
   */
  readonly backend?: 'in-process' | 'daemon'
}

export interface Settings {
  readonly worktree: WorktreeSettings
  readonly terminal: TerminalSettings
  /** Default session type for the New-Session dropdown (§5.4). */
  readonly defaultSessionTypeId: string
  /** Worktree create timeout override (ms); default 30 000 — script AND git (§6.4). */
  readonly worktreeCreateTimeoutMs?: number
  /**
   * Chords for the user-configurable actions (§5.4): cycle to the NEXT / PREVIOUS
   * session, move to the NEXT / PREVIOUS task, create a new session, create a new
   * task, close the active session, and open terminal search. Each is a canonical
   * chord string (`parseChord` in `renderer/keybindings/chords.ts`), e.g.
   * `'Ctrl+Shift+ArrowRight'` — ANY key with at least one modifier is allowed, and
   * every action is bound independently (no "opposite" inference). Defaults:
   * session next/prev 'Ctrl+Shift+ArrowRight' / 'Ctrl+Shift+ArrowLeft';
   * task next/prev 'Ctrl+Shift+ArrowDown' / 'Ctrl+Shift+ArrowUp';
   * new session 'Ctrl+Shift+KeyN'; new task 'Ctrl+Shift+KeyT';
   * close session 'Ctrl+Shift+KeyW'; terminal search 'Ctrl+Shift+KeyF'.
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

/** A deep-partial patch for `save` (nested objects merged, not replaced). */
export interface SettingsPatch {
  readonly worktree?: Partial<WorktreeSettings>
  readonly terminal?: Partial<TerminalSettings>
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

export interface SettingsStore {
  /** Load settings, filling defaults for any missing keys. */
  load(): Settings
  /** Merge `patch` into the stored settings and persist; returns the result. */
  save(patch: SettingsPatch): Settings
}
