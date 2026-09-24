/**
 * Init-time, merge-safe wiring of Octopus's Claude Code integration into the user's
 * `~/.claude/settings.json` (DESIGN §9.2, §12.1). This is what makes Claude state
 * detection work OUT OF THE BOX for every Octopus user — a user who never touches
 * their Claude config still gets authoritative Working/Waiting/Blocked in Octopus.
 *
 * ## The model (replaces the old socket transport)
 * State no longer travels over a per-session Unix socket. Instead a single python3
 * bridge ({@link ensureClaudeStateScript}, written into the data dir on startup) owns
 * ALL of the state logic; the settings.json only points Claude's events at it:
 *   - every lifecycle HOOK runs `python3 <script> hook <Event>` — the script maps the
 *     event to a state and records it in the session's state file;
 *   - the STATUSLINE runs `python3 <script> statusline` — the script derives state
 *     from the transcript (the resume-recovery path), records it, THEN delegates to
 *     the user's ORIGINAL statusline command and prints its output verbatim, so the
 *     user's status bar is unchanged.
 * Octopus's app-side watcher reads those files and feeds `ingestSessionState`.
 *
 * Correlation is by `OCTOPUS_SESSION_ID` (injected into every managed PTY), which the
 * hook/statusline subprocesses inherit — so one GLOBAL settings entry serves every
 * session and every worktree, and the script is a silent no-op outside Octopus.
 *
 * ## Merge-safe, never clobber (the hard requirement)
 * We MUST NOT destroy a user's existing hooks/statusline/config. The merge:
 *   - reads the existing JSON (missing/corrupt ⇒ treated as `{}` / left alone);
 *   - preserves every existing key and every existing hook entry verbatim;
 *   - APPENDS our command to each event array only when an Octopus entry (tagged with
 *     {@link OCTOPUS_HOOK_MARKER}) isn't already there — idempotent across restarts,
 *     a drifted command replaces only the prior Octopus entry;
 *   - for the statusline, SAVES the user's original command (so the script can chain
 *     to it) before repointing `statusLine.command` at the bridge — and never
 *     re-wraps its own wrapper.
 *
 * Pure core ({@link mergeClaudeHooks} / {@link mergeStatusLine}) + effectful wrapper
 * ({@link ensureClaudeHooks}), matching the paths.ts resolver/wrapper split.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  ensureClaudeStateScript,
  CLAUDE_STATE_DIR_NAME,
  ORIGINAL_STATUSLINE_FILE
} from './octopus-claude-state.script'

/** Marker embedded in every Octopus hook/statusline command so we find + replace only ours. */
export const OCTOPUS_HOOK_MARKER = '#octopus-state'

/** A Claude settings hook command entry. */
interface HookCommand {
  readonly type: 'command'
  readonly command: string
  readonly [k: string]: unknown
}

/** A Claude settings hook matcher group: `{ matcher?, hooks: [...] }`. */
interface HookGroup {
  matcher?: string
  hooks?: HookCommand[]
  [k: string]: unknown
}

/** The `statusLine` block Claude renders each turn. */
interface StatusLine {
  type?: string
  command?: string
  [k: string]: unknown
}

/** The subset of Claude settings we touch; everything else is passed through. */
interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>
  statusLine?: StatusLine
  [k: string]: unknown
}

/**
 * The Claude lifecycle events Octopus wires. The state each maps to lives in the
 * python bridge (`HOOK_STATES`), NOT here — the hook command only names the event, so
 * the mapping has a single source of truth. Mirrors the prior socket mapping:
 *   Stop/StopFailure → waiting, Notification/PermissionRequest → blocked (Notification
 *   suppresses the idle "waiting for your input" reminder, in the script), everything
 *   else → working.
 */
export const HOOK_EVENTS: readonly string[] = [
  'Stop',
  'StopFailure',
  'Notification',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit'
]

/**
 * The idle "waiting for your input" reminder Claude fires AFTER a turn already ended.
 * Kept as an exported constant for documentation/parity; the actual suppression now
 * happens inside the python bridge (see `IDLE_NOTIFICATION_MARKER` there).
 */
export const IDLE_NOTIFICATION_MARKER = 'waiting for your input'

/**
 * The shell one-liner a hook runs: invoke the bridge for this event, never fail the
 * hook (`|| true`), tagged with {@link OCTOPUS_HOOK_MARKER}. The script is a no-op
 * when `OCTOPUS_SESSION_ID` is unset, so this is harmless outside an Octopus PTY.
 */
export function hookCommand(scriptPath: string, event: string): string {
  return `python3 '${shSingleQuote(scriptPath)}' hook ${event} 2>/dev/null || true ${OCTOPUS_HOOK_MARKER}`
}

/** The statusline command: run the bridge in `statusline` mode (it chains to the original). */
export function statusLineCommand(scriptPath: string): string {
  return `python3 '${shSingleQuote(scriptPath)}' statusline ${OCTOPUS_HOOK_MARKER}`
}

/** Escape a path for embedding inside a single-quoted sh literal. */
function shSingleQuote(value: string): string {
  return value.replace(/'/g, `'\\''`)
}

/** True if a command string is Octopus's (tagged with the marker). */
function isOctopusCommand(command: unknown): command is string {
  return typeof command === 'string' && command.includes(OCTOPUS_HOOK_MARKER)
}

/** True if a hook group array already contains an Octopus-tagged command. */
function hasOctopusEntry(groups: HookGroup[]): boolean {
  return groups.some((g) => (g.hooks ?? []).some((h) => isOctopusCommand(h.command)))
}

/** Drop any Octopus-tagged command entries (and now-empty groups) from an event array. */
function stripOctopusEntries(groups: HookGroup[]): HookGroup[] {
  return (
    groups
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter((h) => !isOctopusCommand(h.command))
      }))
      // Keep a group only if it still has hooks OR carried no hooks array to begin with
      // (a user group we shouldn't have touched — preserve verbatim shape).
      .filter((g) => (g.hooks && g.hooks.length > 0) || g.hooks === undefined)
  )
}

/**
 * Pure merge: return `settings` with Octopus's hooks ensured, preserving every
 * existing key + user hook. Idempotent — re-running yields deep-equal output; a
 * changed Octopus command replaces only the prior Octopus entry. Returns a NEW object.
 */
export function mergeClaudeHooks(settings: ClaudeSettings, scriptPath: string): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    hooks[event] = groups.map((g) => ({ ...g, hooks: g.hooks ? [...g.hooks] : g.hooks }))
  }

  for (const event of HOOK_EVENTS) {
    const existing = hooks[event] ?? []
    // Refresh: strip a stale Octopus entry, then append the current command.
    const userGroups = stripOctopusEntries(existing)
    userGroups.push({ hooks: [{ type: 'command', command: hookCommand(scriptPath, event) }] })
    hooks[event] = userGroups
  }

  return { ...settings, hooks }
}

/**
 * Pure merge for the statusline chain: point `statusLine.command` at the bridge, and
 * SAVE the user's original command so the script can delegate to it. Returns
 * `{ settings, savedOriginal }` — `savedOriginal` is the command the effectful wrapper
 * must persist to the `original-statusline` file (undefined ⇒ nothing to save, either
 * there was no prior statusline or ours was already installed).
 *
 * Idempotent: if `command` is already the Octopus wrapper we don't re-wrap (and we
 * report no new original to save — the prior save stands).
 */
export function mergeStatusLine(
  settings: ClaudeSettings,
  scriptPath: string
): { settings: ClaudeSettings; savedOriginal?: string } {
  const current = settings.statusLine ?? {}
  const currentCommand = typeof current.command === 'string' ? current.command : undefined

  if (currentCommand !== undefined && isOctopusCommand(currentCommand)) {
    // Already ours — refresh the command text in case the script path drifted, but do
    // NOT capture it as the original (that would overwrite the real saved original).
    if (currentCommand === statusLineCommand(scriptPath)) {
      return { settings }
    }
    return {
      settings: {
        ...settings,
        statusLine: { ...current, type: 'command', command: statusLineCommand(scriptPath) }
      }
    }
  }

  return {
    settings: {
      ...settings,
      statusLine: { ...current, type: 'command', command: statusLineCommand(scriptPath) }
    },
    // A prior user command (if any) becomes the chain target. Absent ⇒ the script's
    // delegation is a no-op passthrough (Octopus adds no bar of its own).
    savedOriginal: currentCommand
  }
}

/** True if `settings` already has every Octopus hook AND the statusline wrapper. */
export function hasAllOctopusHooks(settings: ClaudeSettings, scriptPath: string): boolean {
  const hooksOk = HOOK_EVENTS.every((event) => {
    const groups = settings.hooks?.[event]
    return groups !== undefined && hasOctopusEntry(groups)
  })
  const statusOk = settings.statusLine?.command === statusLineCommand(scriptPath)
  return hooksOk && statusOk
}

export interface ClaudeHooksResult {
  /** What happened, for the boot log. */
  readonly action: 'written' | 'already-present' | 'skipped-corrupt' | 'error'
  readonly path: string
  readonly message?: string
}

/** Resolve the user-global Claude settings path (`~/.claude/settings.json`). */
export function claudeSettingsPath(home: string = homedir()): string {
  return join(home, '.claude', 'settings.json')
}

/**
 * Effectful wrapper: write the python bridge into `dataDir`, then ensure the Octopus
 * hooks + statusline chain in `~/.claude/settings.json`, creating the file/dir if
 * absent and merge-preserving an existing one (§9.2). Never throws — best-effort.
 *
 * A file that exists but is NOT valid JSON is LEFT UNTOUCHED and reported
 * `skipped-corrupt`. `already-present` short-circuits the common restart path with no
 * write (idempotent). The user's original statusline command is saved to
 * `<dataDir>/claude-state/original-statusline` so the bridge can chain to it.
 */
export function ensureClaudeHooks(dataDir: string, home: string = homedir()): ClaudeHooksResult {
  const scriptPath = ensureClaudeStateScript(dataDir)
  const path = claudeSettingsPath(home)

  let raw: string | undefined
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    raw = undefined // missing file — we'll create it.
  }

  let existing: ClaudeSettings = {}
  if (raw !== undefined && raw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { action: 'skipped-corrupt', path, message: 'settings.json is not a JSON object' }
      }
      existing = parsed as ClaudeSettings
    } catch {
      return { action: 'skipped-corrupt', path, message: 'settings.json is not valid JSON' }
    }
  }

  // Merge hooks, then the statusline chain (capturing any original to save).
  const withHooks = mergeClaudeHooks(existing, scriptPath)
  const { settings: merged, savedOriginal } = mergeStatusLine(withHooks, scriptPath)

  // Persist the saved original (if this run captured one) so the bridge can chain.
  if (savedOriginal !== undefined) {
    saveOriginalStatusLine(dataDir, savedOriginal)
  }

  if (JSON.stringify(merged) === JSON.stringify(existing)) {
    return { action: 'already-present', path }
  }
  return writeMerged(path, merged)
}

/** Persist the user's original statusline command for the bridge to chain to. */
function saveOriginalStatusLine(dataDir: string, command: string): void {
  try {
    const file = join(dataDir, CLAUDE_STATE_DIR_NAME, ORIGINAL_STATUSLINE_FILE)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, command, 'utf8')
  } catch {
    // Best-effort: if we can't save it, the bridge's delegation becomes a no-op — the
    // status bar is empty, but state capture still works. Never fail boot.
  }
}

function writeMerged(path: string, merged: ClaudeSettings): ClaudeHooksResult {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    return { action: 'written', path }
  } catch (err) {
    return { action: 'error', path, message: err instanceof Error ? err.message : String(err) }
  }
}
