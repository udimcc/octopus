/**
 * `SettingsStore` over a human-editable `settings.json` (DESIGN §6.3, §6.4).
 * Settings are small and hand-editable, so JSON — not SQLite — per §6.3.
 *
 * Mirrors the pure-resolver / effectful-wrapper split of `env/paths.ts`:
 *   - `parseSettings` / `serializeSettings` / `mergeSettings` / `DEFAULT_SETTINGS`
 *     are pure and exhaustively unit-testable with no filesystem.
 *   - the class does the only I/O (read on load, atomic write on save).
 *
 * `worktree.location` defaults to '' (so the shape is always complete and the
 * settings pane can render); the composition root substitutes the home-based
 * default (`~/octopus_repos`) at resolution time — the frozen constant must not
 * bake in `~`. Never persist secrets here (I16).
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { Settings, SettingsPatch, SettingsStore } from '../../ports/settings-store'

/** Complete default settings; every key present so the shape is total. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  worktree: Object.freeze({ location: '' }),
  terminal: Object.freeze({}),
  defaultSessionTypeId: 'terminal',
  groupTasksByRepo: true,
  sessionNextKey: 'Ctrl+Shift+ArrowRight',
  sessionPrevKey: 'Ctrl+Shift+ArrowLeft',
  taskNextKey: 'Ctrl+Shift+ArrowDown',
  taskPrevKey: 'Ctrl+Shift+ArrowUp',
  newSessionKey: 'Ctrl+Shift+KeyN',
  newTaskKey: 'Ctrl+Shift+KeyT',
  closeSessionKey: 'Ctrl+Shift+KeyW',
  searchKey: 'Ctrl+Shift+KeyF',
  copyKey: 'Ctrl+Shift+KeyC',
  pasteKey: 'Ctrl+Shift+KeyV'
}) as Settings

/**
 * Parse raw settings.json text into a complete `Settings`, filling defaults for
 * any missing/invalid keys. Tolerant by design: a hand-edited file with a typo
 * should degrade to defaults, not crash the app. Unknown keys are dropped.
 */
export function parseSettings(raw: string): Settings {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return DEFAULT_SETTINGS
  }
  if (typeof obj !== 'object' || obj === null) {
    return DEFAULT_SETTINGS
  }
  return mergeSettings(DEFAULT_SETTINGS, obj as SettingsPatch)
}

/** Serialize settings for on-disk storage (pretty, trailing newline). */
export function serializeSettings(settings: Settings): string {
  return JSON.stringify(settings, null, 2) + '\n'
}

/**
 * Deep-merge a patch over a base: nested `worktree`/`terminal` objects merge
 * key-by-key; scalars replace. Only known keys are read, so an untrusted or
 * stale file cannot inject arbitrary properties — a lingering `scripts` block
 * from the pre-redesign format is silently dropped (no migration needed).
 */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  return {
    worktree: {
      location: pickString(patch.worktree?.location, base.worktree.location)
    },
    terminal: {
      shell: pickString(patch.terminal?.shell, base.terminal.shell),
      backend: pickBackend(patch.terminal?.backend, base.terminal.backend),
      // Preserve absence (undefined) like `shell`/`backend`: an unset value means
      // "on" via the `!== false` convention at the read sites (§9.5). This keeps
      // DEFAULT_SETTINGS a fixed point under serialize→parse.
      statusChangeNotifications: pickBoolean(
        patch.terminal?.statusChangeNotifications,
        base.terminal.statusChangeNotifications
      )
    },
    defaultSessionTypeId: pickString(patch.defaultSessionTypeId, base.defaultSessionTypeId),
    worktreeCreateTimeoutMs: pickNumber(
      patch.worktreeCreateTimeoutMs,
      base.worktreeCreateTimeoutMs
    ),
    groupTasksByRepo: pickBoolean(patch.groupTasksByRepo, base.groupTasksByRepo),
    sessionNextKey: pickString(patch.sessionNextKey, base.sessionNextKey),
    sessionPrevKey: pickString(patch.sessionPrevKey, base.sessionPrevKey),
    taskNextKey: pickString(patch.taskNextKey, base.taskNextKey),
    taskPrevKey: pickString(patch.taskPrevKey, base.taskPrevKey),
    newSessionKey: pickString(patch.newSessionKey, base.newSessionKey),
    newTaskKey: pickString(patch.newTaskKey, base.newTaskKey),
    closeSessionKey: pickString(patch.closeSessionKey, base.closeSessionKey),
    searchKey: pickString(patch.searchKey, base.searchKey),
    copyKey: pickString(patch.copyKey, base.copyKey),
    pasteKey: pickString(patch.pasteKey, base.pasteKey)
  }
}

function pickString(value: unknown, fallback: string): string
function pickString(value: unknown, fallback: string | undefined): string | undefined
function pickString(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === 'string' ? value : fallback
}

function pickNumber(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pickBoolean(value: unknown, fallback: boolean): boolean
function pickBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined
function pickBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : fallback
}

/** Only the two known backends survive; anything else falls back (tolerant parse). */
function pickBackend(
  value: unknown,
  fallback: 'in-process' | 'daemon' | undefined
): 'in-process' | 'daemon' | undefined {
  return value === 'in-process' || value === 'daemon' ? value : fallback
}

export class JsonSettingsStore implements SettingsStore {
  private readonly path: string
  private cache: Settings

  constructor(path: string) {
    this.path = path
    this.cache = DEFAULT_SETTINGS
  }

  /** Read settings.json (defaults if absent/unreadable) and cache the result. */
  load(): Settings {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      // First run or unreadable: fall back to defaults without writing a file —
      // an unconfigured install shouldn't silently materialize a settings file.
      this.cache = DEFAULT_SETTINGS
      return this.cache
    }
    this.cache = parseSettings(raw)
    return this.cache
  }

  /** Merge `patch` over the current settings, persist atomically, and return it. */
  save(patch: SettingsPatch): Settings {
    const next = mergeSettings(this.cache, patch)
    this.writeAtomic(serializeSettings(next))
    this.cache = next
    return next
  }

  /** Write via a temp file + rename so a crash never leaves a truncated file. */
  private writeAtomic(contents: string): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
