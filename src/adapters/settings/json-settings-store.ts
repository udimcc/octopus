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
 *
 * `projects` (§5.4, §6.3) is intentionally absent from `DEFAULT_SETTINGS`: its
 * absence (vs. an empty array) is meaningful (see `Settings.projects`), so the
 * default must not manufacture either value. `pickProjects` tolerantly drops
 * malformed entries from a hand-edited file instead of discarding the whole list.
 *
 * **Boot-seed safety (§6.3).** A missing/unreadable/malformed settings.json both
 * fall back to `DEFAULT_SETTINGS`, which has no `projects` key — but those two
 * cases must NOT be treated alike by `seedProjects`: "the file doesn't exist" is
 * genuinely "never seeded" (seeding is correct), while "the file exists but is
 * corrupt" must NOT be seeded over (that would silently replace a user's broken
 * — but recoverable by hand — file with defaults-plus-seed). `loadFailed()`
 * (the `SettingsStore` port) distinguishes the two for `seedProjects` to check.
 * Symmetrically, `save()` re-reads settings.json fresh (not the possibly-stale
 * in-memory cache) before merging the patch: a file that still parses is merged
 * over as-is (so a user's hand repair of a previously-corrupt file survives the
 * next save instead of being overwritten by defaults-plus-patch); a file that is
 * corrupt is first backed up to `settings.json.corrupt-<timestamp>` and then
 * merged over `DEFAULT_SETTINGS`; a missing file (ENOENT) merges over the
 * in-memory cache, since there is nothing fresh on disk to read.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type {
  JiraLastFilters,
  JiraSettings,
  JiraSprintFilterSetting,
  ProjectSettings,
  Settings,
  SettingsPatch,
  SettingsStore
} from '../../ports/settings-store'

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
  pasteKey: 'Ctrl+Shift+KeyV',
  issuesKey: 'Alt+Shift+KeyI',
  // Split panes (DESIGN §5.7).
  splitRightKey: 'Ctrl+Shift+KeyE',
  splitDownKey: 'Ctrl+Shift+KeyO',
  focusPaneLeftKey: 'Ctrl+Shift+KeyH',
  focusPaneRightKey: 'Ctrl+Shift+KeyL',
  focusPaneUpKey: 'Ctrl+Shift+KeyK',
  focusPaneDownKey: 'Ctrl+Shift+KeyJ'
}) as Settings

/**
 * Parse raw settings.json text, reporting whether the WHOLE document was usable
 * (valid JSON, and a plain object — a top-level array or other non-object JSON
 * value counts as corrupt, same as unparseable text) as opposed to a single bad
 * field — those are tolerated per-field by `mergeSettings`/`pickProjects` and
 * are not a parse failure. Factored out of `parseSettings` so
 * `JsonSettingsStore.load`/`save` can distinguish "defaulted because the file
 * is garbage" from "defaulted because the file simply doesn't exist" (DESIGN
 * §6.3 — see `loadFailed` on the `SettingsStore` port).
 */
function tryParseSettings(raw: string): { ok: true; settings: Settings } | { ok: false } {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false }
  }
  return { ok: true, settings: mergeSettings(DEFAULT_SETTINGS, obj as SettingsPatch) }
}

/**
 * Parse raw settings.json text into a complete `Settings`, filling defaults for
 * any missing/invalid keys. Tolerant by design: a hand-edited file with a typo
 * should degrade to defaults, not crash the app. Unknown keys are dropped. Pure
 * (DESIGN §6.3 pure-resolver / effectful-wrapper split) — stays the thin public
 * wrapper; `JsonSettingsStore` uses `tryParseSettings` directly when it needs to
 * know WHETHER the fallback happened, not just the fallback value.
 */
export function parseSettings(raw: string): Settings {
  const result = tryParseSettings(raw)
  return result.ok ? result.settings : DEFAULT_SETTINGS
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
      // "on" via the `!== false` convention at the read sites (§9, §9.2, §9.5).
      // This keeps DEFAULT_SETTINGS a fixed point under serialize→parse.
      //
      // `stateDetection`/`injectClaudeHooks` were previously NOT parsed here at
      // all (bug): a hand-set value in settings.json was silently discarded on
      // every save/round-trip (composition-root and the session managers DO read
      // them, so a user's opt-out never took effect), and any save would delete
      // the keys entirely from the file. Fixed by parsing them with the same
      // tolerant per-field idiom as the rest of `terminal` (§6.3).
      stateDetection: pickBoolean(patch.terminal?.stateDetection, base.terminal.stateDetection),
      injectClaudeHooks: pickBoolean(
        patch.terminal?.injectClaudeHooks,
        base.terminal.injectClaudeHooks
      ),
      statusChangeNotifications: pickBoolean(
        patch.terminal?.statusChangeNotifications,
        base.terminal.statusChangeNotifications
      )
    },
    defaultSessionTypeId: pickString(patch.defaultSessionTypeId, base.defaultSessionTypeId),
    projects: pickProjects(patch.projects, base.projects),
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
    pasteKey: pickString(patch.pasteKey, base.pasteKey),
    issuesKey: pickString(patch.issuesKey, base.issuesKey),
    splitRightKey: pickString(patch.splitRightKey, base.splitRightKey),
    splitDownKey: pickString(patch.splitDownKey, base.splitDownKey),
    focusPaneLeftKey: pickString(patch.focusPaneLeftKey, base.focusPaneLeftKey),
    focusPaneRightKey: pickString(patch.focusPaneRightKey, base.focusPaneRightKey),
    focusPaneUpKey: pickString(patch.focusPaneUpKey, base.focusPaneUpKey),
    focusPaneDownKey: pickString(patch.focusPaneDownKey, base.focusPaneDownKey),
    jira: pickJira(patch.jira, base.jira)
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

/**
 * Tolerant parse of the `projects` list (§6.3): `undefined` (key absent, or not an
 * array) falls back to preserve the "never seeded" vs. "[]" distinction (see
 * `Settings.projects`) — it must NOT default to `[]`. When it IS an array, each
 * entry is validated independently rather than discarding the whole list: only
 * plain objects with a non-empty string `path` survive, and a `defaultBranch`
 * that isn't a non-empty string is dropped (not just falling back) so a bad
 * `defaultBranch` doesn't disqualify an otherwise-valid entry. `path` is
 * trimmed and, once trimmed, must be a non-empty ABSOLUTE path (`node:path`
 * `isAbsolute`, which also covers a Windows drive/UNC path) — a relative or
 * blank entry from a hand-edited file is dropped the same way a missing `path`
 * is.
 */
function pickProjects(
  value: unknown,
  fallback: readonly ProjectSettings[] | undefined
): readonly ProjectSettings[] | undefined {
  if (!Array.isArray(value)) {
    return fallback
  }
  const projects: ProjectSettings[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { path: rawPath, defaultBranch } = entry as { path?: unknown; defaultBranch?: unknown }
    if (typeof rawPath !== 'string') {
      continue
    }
    const path = rawPath.trim()
    if (path.length === 0 || !isAbsolute(path)) {
      continue
    }
    projects.push(
      typeof defaultBranch === 'string' && defaultBranch.length > 0
        ? { path, defaultBranch }
        : { path }
    )
  }
  return projects
}

/** Trim a string value; `undefined` (or non-string, or empty after trim) falls through. */
function pickTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Validate a `sprint` filter candidate against the two shapes `JiraSprintFilterSetting`
 * allows exactly — `{kind:'id', id, name}` (a finite `id`, `name` any string) or
 * `{kind:'name', text}` (a non-empty, trimmed `text`) — dropping anything that matches
 * neither (wrong `kind`, missing/mistyped fields, or a non-object).
 */
function pickJiraSprintFilter(value: unknown): JiraSprintFilterSetting | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as { kind?: unknown; id?: unknown; name?: unknown; text?: unknown }
  if (
    candidate.kind === 'id' &&
    typeof candidate.id === 'number' &&
    Number.isFinite(candidate.id) &&
    typeof candidate.name === 'string'
  ) {
    return { kind: 'id', id: candidate.id, name: candidate.name }
  }
  if (candidate.kind === 'name') {
    const text = pickTrimmedString(candidate.text)
    if (text !== undefined) {
      return { kind: 'name', text }
    }
  }
  return undefined
}

/**
 * Validate a `lastFilters` candidate field-by-field (DESIGN §Jira import): each
 * known key is kept only if it survives its own check — strings trimmed with empty
 * strings dropped, `days` a positive integer, `sprint` one of its two exact shapes
 * (`pickJiraSprintFilter`) — and anything else (unknown keys, wrong types) is
 * dropped silently rather than invalidating the whole object. A non-object
 * candidate (including an array) is entirely invalid.
 */
function pickJiraLastFiltersCandidate(value: unknown): JiraLastFilters | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  const project = pickTrimmedString(candidate.project)
  const assignee = pickTrimmedString(candidate.assignee)
  const issueKey = pickTrimmedString(candidate.issueKey)
  const days =
    typeof candidate.days === 'number' && Number.isInteger(candidate.days) && candidate.days > 0
      ? candidate.days
      : undefined
  const sprint = pickJiraSprintFilter(candidate.sprint)
  return {
    ...(project !== undefined && { project }),
    ...(assignee !== undefined && { assignee }),
    ...(issueKey !== undefined && { issueKey }),
    ...(days !== undefined && { days }),
    ...(sprint !== undefined && { sprint })
  }
}

/**
 * Tolerant parse of the `jira` block (DESIGN §Jira import). The API key never
 * lives here (I16) — only the non-secret `lastFilters` knob. A patch that omits
 * `jira` entirely, or whose `jira` isn't a plain object, keeps the existing block
 * unchanged (same "unrelated patch" idiom as the rest of `mergeSettings`). A
 * present-but-malformed `lastFilters` (not a plain object) likewise falls back to
 * the existing block rather than wiping it. A validly-shaped `lastFilters`
 * replaces the existing one WHOLESALE (per-field pruning only, via
 * `pickJiraLastFiltersCandidate` — it is the last-used filter set, not a target
 * to merge field-by-field, same as `projects`).
 */
function pickJira(value: unknown, fallback: JiraSettings | undefined): JiraSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback
  }
  const { lastFilters } = value as { lastFilters?: unknown }
  if (lastFilters === undefined) {
    return fallback
  }
  const picked = pickJiraLastFiltersCandidate(lastFilters)
  return picked === undefined ? fallback : { lastFilters: picked }
}

export class JsonSettingsStore implements SettingsStore {
  private readonly path: string
  private cache: Settings
  /** See `loadFailed()`. Set by every `load()`; starts false (nothing loaded yet). */
  private failedLastLoad = false

  constructor(path: string) {
    this.path = path
    this.cache = DEFAULT_SETTINGS
  }

  /**
   * Read settings.json (defaults if absent/unreadable) and cache the result.
   * Also updates the flag `loadFailed()` reports (DESIGN §6.3).
   */
  load(): Settings {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (err) {
      // ENOENT = first run / never configured — NOT a failure: an unconfigured
      // install shouldn't silently materialize a settings file, and the absent
      // `projects` key correctly means "never seeded". Any OTHER read error
      // (EACCES, EISDIR, a transient I/O fault) means a file IS there but we
      // could not read it — flag that distinctly, so a caller like `seedProjects`
      // doesn't mistake "I don't know what's in the real file" for "the real file
      // genuinely has no projects key yet" and clobber it (see `loadFailed`).
      this.failedLastLoad = !isEnoent(err)
      this.cache = DEFAULT_SETTINGS
      return this.cache
    }
    const parsed = tryParseSettings(raw)
    this.failedLastLoad = !parsed.ok
    this.cache = parsed.ok ? parsed.settings : DEFAULT_SETTINGS
    return this.cache
  }

  /** True iff the most recent `load()` found settings.json unreadable or unparseable. */
  loadFailed(): boolean {
    return this.failedLastLoad
  }

  /**
   * Merge `patch` over the current on-disk settings, persist atomically, and
   * return it. The base to merge over is re-read FRESH from disk (not the
   * possibly-stale `this.cache`) via `readBaseForSave`, because `save` is also
   * how the boot seed and add/remove-project write, and any of those must not
   * silently destroy a hand edit made since the last `load()`: a file that
   * still parses is merged over as read (so a hand-repaired file survives);
   * a corrupt file is backed up to `settings.json.corrupt-<timestamp>` (DESIGN
   * §6.3) and merged over `DEFAULT_SETTINGS`; a missing file (ENOENT) merges
   * over `this.cache`, since there is nothing fresh on disk to prefer.
   */
  save(patch: SettingsPatch): Settings {
    const base = this.readBaseForSave()
    const next = mergeSettings(base, patch)
    this.writeAtomic(serializeSettings(next))
    this.cache = next
    return next
  }

  /**
   * Read settings.json fresh and decide what `save` should merge the patch
   * over (DESIGN §6.3). A single read serves both the "is it corrupt" check
   * and the backup copy, so the file is read at most once per `save`:
   *   - parses as a plain object: return that fresh parse.
   *   - reads but is corrupt (bad JSON / not a plain object, including a
   *     top-level array): back it up to `settings.json.corrupt-<timestamp>`
   *     before it's lost to the overwrite, and return `DEFAULT_SETTINGS`.
   *   - ENOENT: nothing on disk to prefer; return `this.cache`.
   *   - any other read error (EACCES, EISDIR, a transient I/O fault): the file
   *     couldn't be read to back it up before the impending overwrite — warn
   *     (rather than fail silently) and return `this.cache`.
   * Best-effort throughout: a failed backup attempt is logged but does not
   * block the save — refusing to save would just leave the broken file broken
   * AND block the user's current edit.
   */
  private readBaseForSave(): Settings {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (err) {
      if (!isEnoent(err)) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(
          `[octopus] settings.json could not be read before saving (it will be overwritten): ${message}`
        )
      }
      return this.cache
    }
    const parsed = tryParseSettings(raw)
    if (parsed.ok) {
      return parsed.settings
    }
    this.backupCorrupt(raw)
    return DEFAULT_SETTINGS
  }

  /** Copy `raw` (known-corrupt on-disk settings.json text) to a timestamped backup. */
  private backupCorrupt(raw: string): void {
    const backupPath = `${this.path}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, raw, { encoding: 'utf8', mode: 0o600 })
      console.warn(
        `[octopus] settings.json was unreadable; backed up to ${backupPath} before overwriting`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[octopus] settings.json was unreadable; backup copy failed: ${message}`)
    }
  }

  /** Write via a temp file + rename so a crash never leaves a truncated file. */
  private writeAtomic(contents: string): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }
}

/** True iff `err` is a Node filesystem error with code `ENOENT` (path absent). */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
