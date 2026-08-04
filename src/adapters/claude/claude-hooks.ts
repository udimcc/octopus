/**
 * Init-time, merge-safe injection of Octopus's Claude Code hooks (DESIGN §9.2,
 * §12.1). This is what makes phase-2 Claude state detection work OUT OF THE BOX for
 * every Octopus user: on startup Octopus ensures the user's Claude settings wire the
 * three lifecycle hooks to tiny one-liners that write a state JSON frame to
 * `$OCTOPUS_STATE_SOCKET` (the per-session socket §9.2 provisions). A user who never
 * touches their Claude config still gets authoritative Working/Waiting/Blocked.
 *
 * ## Why the USER-GLOBAL settings.json (not per-worktree)
 * The socket path is a per-session ENV var the hook command reads at RUN time, so a
 * SINGLE global hook in `~/.claude/settings.json` serves every session and every
 * worktree — no per-worktree file to write on each task create, and it survives
 * worktree deletion. DESIGN §9.2 phrases it as a worktree file; the env-var
 * indirection lets one global entry subsume that, which is the user-directed
 * init-time approach ("check on init and edit settings.json if not found").
 *
 * ## Merge-safe, never clobber (the hard requirement)
 * We MUST NOT destroy a user's existing hooks/config. The merge:
 *   - reads the existing JSON (missing/corrupt ⇒ treated as `{}`, never overwritten
 *     blind — a corrupt file is left alone and reported, see {@link ensureClaudeHooks});
 *   - preserves every existing key and every existing hook entry verbatim;
 *   - APPENDS our command entry to each event array only when an Octopus entry
 *     (tagged with {@link OCTOPUS_HOOK_MARKER}) isn't already there — so it is
 *     idempotent across restarts and upgrades (a changed command replaces only the
 *     prior Octopus entry, never a user's).
 *
 * ## The hook commands
 * Each is a POSIX-sh one-liner, guarded so it is a silent no-op when the socket var
 * is unset/gone (§9.2 graceful degradation) and never fails the hook. It sends ONE
 * newline-delimited JSON frame via `nc -U` (the {@link bindStateSocket} listener
 * validates + never executes it). Mapping (refines §9.2 with the accurate attention
 * signal — `Notification` is Claude's real "needs the user" event; there is no
 * silence-heuristic backstop, the hooks are the sole source of Claude's state, §9):
 *   - `Stop`          → waiting (turn finished cleanly)
 *   - `StopFailure`   → waiting (turn ended ABNORMALLY — the user interrupted it with
 *     Ctrl-C / ESC, or it errored. `Stop` does NOT fire in this case, so without this
 *     hook a user-interrupted turn stays stuck on Working until Claude actually exits
 *     and the /proc sentinel clears it. This is the interrupt signal that closes that
 *     gap — Claude stays alive at its own prompt, so the sentinel never fires).
 *   - `Notification`  → blocked (permission / attention request) — but the idle
 *     "waiting for your input" reminder Claude fires AFTER a turn already ended is
 *     suppressed (it is not a real input need; see {@link notificationHookCommand}).
 *   - `PermissionRequest` → blocked (a first-class tool-approval prompt — the clean
 *     Needs-input signal, distinct from the overloaded `Notification` event).
 *   - `SubagentStop`  → working (a delegated subagent finished; the MAIN agent is
 *     still mid-turn — do NOT let this read as Idle).
 *   - `PreToolUse`    → working (a tool is starting)
 *   - `PostToolUse`   → working (still Claude's turn)
 *   - `UserPromptSubmit` → working (user handed work back to Claude)
 *
 * Pure core ({@link mergeClaudeHooks}) + effectful wrapper ({@link ensureClaudeHooks}),
 * matching the paths.ts resolver/wrapper split so the merge is unit-testable without
 * a filesystem.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** Marker embedded in every Octopus hook command so we can find + replace only ours. */
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

/** The subset of Claude settings we touch; everything else is passed through. */
interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

/** One event → the JSON state frame its Octopus hook emits (§9.2). */
interface HookSpec {
  readonly event: string
  readonly json: string
  /**
   * Optional override for the shell one-liner. Defaults to {@link hookCommand}(json);
   * `Notification` uses {@link notificationHookCommand} so it can inspect the payload.
   */
  readonly command?: (json: string) => string
}

const HOOK_SPECS: readonly HookSpec[] = [
  { event: 'Stop', json: '{"state":"waiting","reason":"claude_stop"}' },
  { event: 'StopFailure', json: '{"state":"waiting","reason":"stop_failure"}' },
  { event: 'Notification', json: '{"state":"blocked","reason":"notification"}', command: notificationHookCommand },
  { event: 'PermissionRequest', json: '{"state":"blocked","reason":"permission"}' },
  { event: 'SubagentStop', json: '{"state":"working","reason":"subagent_stop"}' },
  { event: 'PreToolUse', json: '{"state":"working","reason":"pre_tool_use"}' },
  { event: 'PostToolUse', json: '{"state":"working","reason":"tool_use"}' },
  { event: 'UserPromptSubmit', json: '{"state":"working","reason":"user_prompt"}' }
]

/**
 * The `Notification` event is emitted for TWO unrelated situations: a genuine
 * permission/tool-approval request (real Needs-input), AND an idle "waiting for your
 * input" reminder Claude fires when a turn has ALREADY ended and the user hasn't
 * typed. Mapping both to `blocked` is the BUG 1 false-positive: after a turn ends
 * (`Stop` → waiting/Idle) the idle reminder would overwrite it with a sticky
 * `blocked`, so the tab reads Needs-input though nothing is blocked.
 *
 * Claude passes the notification payload as JSON on the hook's stdin (a `message`
 * field). We keep the default "Notification ⇒ blocked" (DESIGN §9.2: Notification is
 * the real attention event) but SUPPRESS the idle-reminder message — matched
 * substring-wise on stdin — emitting no frame so the prior `Stop`→waiting stands.
 */
export const IDLE_NOTIFICATION_MARKER = 'waiting for your input'

/**
 * The shell one-liner for a state frame (§9.2). No-op when the socket var is unset,
 * never fails the hook (`|| true`), tagged with {@link OCTOPUS_HOOK_MARKER}. `nc -U`
 * is the DESIGN-specified transport; if `nc` is absent the `|| true` keeps the hook
 * harmless and detection falls back to the heuristic.
 *
 * The `-N -q0 -w1` flags are CRITICAL for hook latency: OpenBSD `nc` (the Debian
 * default) does NOT close a Unix socket on stdin EOF by default — after `printf`
 * finishes it lingers on the half-open connection waiting for the peer, which our
 * listener never closes, so the hook hangs ~2min until nc's default timeout. `-N`
 * shuts the socket down on stdin EOF, `-q0` exits immediately after sending, and
 * `-w1` caps any connect wait at 1s. Together they make the Stop hook return in ms.
 */
export function hookCommand(json: string): string {
  const escaped = json.replace(/'/g, `'\\''`)
  return (
    `[ -n "$OCTOPUS_STATE_SOCKET" ] && ` +
    `printf '%s\\n' '${escaped}' | nc -N -q0 -w1 -U "$OCTOPUS_STATE_SOCKET" 2>/dev/null; ` +
    `true ${OCTOPUS_HOOK_MARKER}`
  )
}

/**
 * The `Notification` one-liner (BUG 1). Same guards/transport/marker as
 * {@link hookCommand}, but it first reads the hook's stdin payload and SUPPRESSES the
 * idle "waiting for your input" reminder (emits no frame) so it can't overwrite the
 * `Stop`→waiting/Idle state with a false `blocked`. Any other Notification (a real
 * permission/attention request) still emits `blocked`, per DESIGN §9.2.
 *
 * `msg=$(cat)` drains stdin (Claude always pipes the payload; if there is none this
 * is an empty string and the frame is sent, matching the old always-blocked behavior
 * for non-payload notifications). The `case` match is a plain substring test — no
 * regex/jq dependency — keeping the hook a portable POSIX-sh one-liner.
 */
export function notificationHookCommand(json: string): string {
  const escaped = json.replace(/'/g, `'\\''`)
  const marker = IDLE_NOTIFICATION_MARKER.replace(/'/g, `'\\''`)
  return (
    `[ -n "$OCTOPUS_STATE_SOCKET" ] && { msg=$(cat); ` +
    `case "$msg" in *'${marker}'*) : ;; *) ` +
    `printf '%s\\n' '${escaped}' | nc -N -q0 -w1 -U "$OCTOPUS_STATE_SOCKET" 2>/dev/null ;; ` +
    `esac; }; ` +
    `true ${OCTOPUS_HOOK_MARKER}`
  )
}

/** True if a hook group array already contains an Octopus-tagged command. */
function hasOctopusEntry(groups: HookGroup[]): boolean {
  return groups.some((g) =>
    (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(OCTOPUS_HOOK_MARKER))
  )
}

/** Drop any Octopus-tagged command entries (and now-empty groups) from an event array. */
function stripOctopusEntries(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).filter(
        (h) => !(typeof h.command === 'string' && h.command.includes(OCTOPUS_HOOK_MARKER))
      )
    }))
    // Keep a group only if it still has hooks OR carried no hooks array to begin with
    // (a user group we shouldn't have touched — preserve verbatim shape).
    .filter((g) => (g.hooks && g.hooks.length > 0) || g.hooks === undefined)
}

/**
 * Pure merge: return `settings` with Octopus's hooks ensured, preserving every
 * existing key + user hook. Idempotent — re-running yields deep-equal output; a
 * changed Octopus command replaces only the prior Octopus entry. Returns a NEW
 * object (does not mutate the input).
 */
export function mergeClaudeHooks(settings: ClaudeSettings): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = {}
  // Deep-ish clone of the existing hooks map (arrays copied; entries reused — we
  // never mutate an existing entry, only append/filter).
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    hooks[event] = groups.map((g) => ({ ...g, hooks: g.hooks ? [...g.hooks] : g.hooks }))
  }

  for (const spec of HOOK_SPECS) {
    const existing = hooks[spec.event] ?? []
    // Refresh: strip a stale Octopus entry, then append the current command. This
    // updates the command across upgrades without disturbing user entries.
    const userGroups = stripOctopusEntries(existing)
    const buildCommand = spec.command ?? hookCommand
    userGroups.push({ hooks: [{ type: 'command', command: buildCommand(spec.json) }] })
    hooks[spec.event] = userGroups
  }

  return { ...settings, hooks }
}

/** True if `settings` already has every Octopus hook present (skip the write). */
export function hasAllOctopusHooks(settings: ClaudeSettings): boolean {
  return HOOK_SPECS.every((spec) => {
    const groups = settings.hooks?.[spec.event]
    return groups !== undefined && hasOctopusEntry(groups)
  })
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
 * Effectful wrapper: ensure the Octopus hooks in `~/.claude/settings.json`, creating
 * the file/dir if absent and merge-preserving an existing one (§9.2). Never throws —
 * hook injection is best-effort (detection degrades to the heuristic on any failure).
 *
 * A file that exists but is NOT valid JSON is LEFT UNTOUCHED and reported
 * `skipped-corrupt` — we must never clobber a user's hand-edited config we can't
 * safely parse. `already-present` short-circuits the common restart path with no
 * write (idempotent).
 */
export function ensureClaudeHooks(home: string = homedir()): ClaudeHooksResult {
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

  if (hasAllOctopusHooks(existing)) {
    // Still refresh if the command text drifted (upgrade): compare the merged output.
    const merged = mergeClaudeHooks(existing)
    if (JSON.stringify(merged) === JSON.stringify(existing)) {
      return { action: 'already-present', path }
    }
    return writeMerged(path, merged)
  }

  return writeMerged(path, mergeClaudeHooks(existing))
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
