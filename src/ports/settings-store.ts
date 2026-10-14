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
  /**
   * Whether the per-session status detection subsystem runs (§9). `true` (default
   * when unset) evaluates each terminal's state (Idle/Working/Needs-input) and
   * renders the tab + task status icons; `false` is the opt-out — no evaluator is
   * built, no `/proc` polling or state socket, and the UI shows no icons (the
   * pre-phase-2 behavior). A pure kill-switch for anyone who doesn't want it.
   */
  readonly stateDetection?: boolean
  /**
   * Whether Octopus auto-injects its Claude Code hooks into the user's
   * `~/.claude/settings.json` at startup (§9.2). `true` (default when unset) runs a
   * merge-safe ensure so ANY Octopus user gets working Layer-3 Claude detection out
   * of the box; `false` opts out (Claude sessions then fall back to the Layer-2
   * heuristic). Never clobbers existing user hooks — it only adds the Octopus ones.
   */
  readonly injectClaudeHooks?: boolean
  /**
   * Whether an in-app notification pops in the active window when a session's
   * status changes (§9.5). `true` (default when unset) shows the "State has changed
   * from … to …" toast; `false` opts out. Read live at each transition.
   */
  readonly statusChangeNotifications?: boolean
}

/**
 * A one-time config entry for a repository (§5.4, §6.3): `path` is the repo's main
 * record — its main checkout, or the bare directory; never a linked worktree — and `defaultBranch` prefills "Source branch" on
 * the New-Task "From New Worktree" tab — editable per-task, never written back.
 */
export interface ProjectSettings {
  readonly path: string
  readonly defaultBranch?: string
}

export interface Settings {
  readonly worktree: WorktreeSettings
  readonly terminal: TerminalSettings
  /** Default session type for the New-Session dropdown (§5.4). */
  readonly defaultSessionTypeId: string
  /**
   * Configured repos shown in the New-Task sidebar (§5.4, §6.3). Absence has a
   * distinct meaning from an empty list: `undefined` means "never seeded" — the
   * one-shot boot seed (one project per distinct existing task repoRoot) still
   * runs; `[]` means the user removed every project, which the seed must never
   * re-populate. Always read `settings.load().projects` directly to distinguish
   * the two — never default this to `[]` upstream of the seed check.
   */
  readonly projects?: readonly ProjectSettings[]
  /** Worktree create timeout override (ms); default 30 000 — script AND git (§6.4). */
  readonly worktreeCreateTimeoutMs?: number
  /** Group the task list by owning repo in the Progress panel (default true). */
  readonly groupTasksByRepo: boolean
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
   * close session 'Ctrl+Shift+KeyW'; terminal search 'Ctrl+Shift+KeyF';
   * copy 'Ctrl+Shift+KeyC'; paste 'Ctrl+Shift+KeyV'; toggle issues drawer
   * 'Alt+Shift+KeyI'.
   */
  readonly sessionNextKey?: string
  readonly sessionPrevKey?: string
  readonly taskNextKey?: string
  readonly taskPrevKey?: string
  readonly newSessionKey?: string
  readonly newTaskKey?: string
  readonly closeSessionKey?: string
  readonly searchKey?: string
  readonly copyKey?: string
  readonly pasteKey?: string
  readonly issuesKey?: string
  /**
   * Split-pane chords (DESIGN §5.7), each bound independently like the chords
   * above (no "opposite" inference): split the focused pane right / down with a
   * NEW terminal, and move pane focus left / right / up / down. Defaults:
   * split right/down 'Ctrl+Shift+KeyE' / 'Ctrl+Shift+KeyO'; focus pane
   * left/right/up/down 'Ctrl+Shift+KeyH' / 'Ctrl+Shift+KeyL' /
   * 'Ctrl+Shift+KeyK' / 'Ctrl+Shift+KeyJ'.
   */
  readonly splitRightKey?: string
  readonly splitDownKey?: string
  readonly focusPaneLeftKey?: string
  readonly focusPaneRightKey?: string
  readonly focusPaneUpKey?: string
  readonly focusPaneDownKey?: string
}

/** A deep-partial patch for `save` (nested objects merged, not replaced). */
export interface SettingsPatch {
  readonly worktree?: Partial<WorktreeSettings>
  readonly terminal?: Partial<TerminalSettings>
  readonly defaultSessionTypeId?: string
  /** See `Settings.projects` for the `undefined` (never seeded) vs. `[]` (user emptied it) rule. */
  readonly projects?: readonly ProjectSettings[]
  readonly worktreeCreateTimeoutMs?: number
  readonly groupTasksByRepo?: boolean
  readonly sessionNextKey?: string
  readonly sessionPrevKey?: string
  readonly taskNextKey?: string
  readonly taskPrevKey?: string
  readonly newSessionKey?: string
  readonly newTaskKey?: string
  readonly closeSessionKey?: string
  readonly searchKey?: string
  readonly copyKey?: string
  readonly pasteKey?: string
  readonly issuesKey?: string
  readonly splitRightKey?: string
  readonly splitDownKey?: string
  readonly focusPaneLeftKey?: string
  readonly focusPaneRightKey?: string
  readonly focusPaneUpKey?: string
  readonly focusPaneDownKey?: string
}

export interface SettingsStore {
  /** Load settings, filling defaults for any missing keys. */
  load(): Settings
  /**
   * True iff the MOST RECENT `load()` found settings.json present on disk but
   * could not read or parse it (I/O error, invalid JSON, or a non-object) — as
   * opposed to the file simply not existing yet (first run / unconfigured
   * install), which is NOT a failure (DESIGN §6.3). Additive, read-only member
   * (same `undefined`-free style as `load`/`save`): both the missing-file case
   * and the unreadable/malformed case fall back to the same `DEFAULT_SETTINGS`
   * (no `projects` key either way), so `seedProjects` cannot tell "genuinely
   * never seeded" from "I don't actually know what's in the real file" without
   * this. It must check `loadFailed()` and skip its one-shot write when true,
   * rather than seeding over a file it couldn't actually read.
   */
  loadFailed(): boolean
  /** Merge `patch` into the stored settings and persist; returns the result. */
  save(patch: SettingsPatch): Settings
}
