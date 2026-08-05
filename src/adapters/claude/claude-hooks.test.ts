import { describe, it, expect } from 'vitest'
import {
  mergeClaudeHooks,
  mergeStatusLine,
  hasAllOctopusHooks,
  hookCommand,
  statusLineCommand,
  HOOK_EVENTS,
  OCTOPUS_HOOK_MARKER
} from './claude-hooks'

const SCRIPT = '/data/octopus/claude-state/octopus-claude-state.py'

/** Grab the single Octopus command for an event from a merged settings object. */
function octopusCommand(merged: ReturnType<typeof mergeClaudeHooks>, event: string): string {
  const cmds = (merged.hooks?.[event] ?? [])
    .flatMap((g) => g.hooks ?? [])
    .map((h) => h.command)
    .filter((c) => c.includes(OCTOPUS_HOOK_MARKER))
  expect(cmds).toHaveLength(1)
  return cmds[0]
}

describe('hookCommand (§9.2)', () => {
  it('invokes the python bridge for the event, never fails the hook, and is tagged', () => {
    const cmd = hookCommand(SCRIPT, 'Stop')
    expect(cmd).toContain('python3')
    expect(cmd).toContain(SCRIPT)
    expect(cmd).toContain('hook Stop')
    expect(cmd).toContain(OCTOPUS_HOOK_MARKER)
    // A trailing `|| true` keeps a missing python3 / script error from failing the hook.
    expect(cmd).toContain('|| true')
  })

  it('single-quote-escapes the script path so the sh literal stays intact', () => {
    const cmd = hookCommand("/data/it's odd/state.py", 'Stop')
    // The apostrophe must be closed-escaped-reopened, never left bare inside '...'.
    expect(cmd).toContain(`'\\''`)
  })
})

describe('statusLineCommand (§9.2 — chain to the original bar)', () => {
  it('runs the bridge in statusline mode, tagged with the marker', () => {
    const cmd = statusLineCommand(SCRIPT)
    expect(cmd).toContain('python3')
    expect(cmd).toContain(SCRIPT)
    expect(cmd).toContain('statusline')
    expect(cmd).toContain(OCTOPUS_HOOK_MARKER)
  })
})

describe('mergeClaudeHooks (§9.2 — merge-safe, idempotent)', () => {
  it('adds all Octopus hook events to an empty settings object', () => {
    const merged = mergeClaudeHooks({}, SCRIPT)
    for (const event of HOOK_EVENTS) {
      expect(merged.hooks?.[event]).toBeDefined()
      const cmd = octopusCommand(merged, event)
      expect(cmd).toContain(`hook ${event}`)
    }
  })

  it('names the event, not the state — mapping lives in the bridge', () => {
    const merged = mergeClaudeHooks({}, SCRIPT)
    // The command carries the event name; no literal state string is embedded.
    const cmd = octopusCommand(merged, 'StopFailure')
    expect(cmd).toContain('hook StopFailure')
    expect(cmd).not.toContain('"state"')
  })

  it('preserves an unrelated user key and a user hook entry verbatim', () => {
    const userHook = { hooks: [{ type: 'command' as const, command: 'echo hi' }] }
    const merged = mergeClaudeHooks(
      {
        model: 'opus',
        hooks: { Stop: [userHook] }
      },
      SCRIPT
    )
    expect(merged.model).toBe('opus')
    // The user's Stop hook survives alongside the appended Octopus one.
    const stop = merged.hooks?.Stop ?? []
    const commands = stop.flatMap((g) => g.hooks ?? []).map((h) => h.command)
    expect(commands).toContain('echo hi')
    expect(commands.some((c) => c.includes(OCTOPUS_HOOK_MARKER))).toBe(true)
  })

  it('is idempotent — re-merging yields deep-equal output (no duplicate Octopus entries)', () => {
    const once = mergeClaudeHooks({}, SCRIPT)
    const twice = mergeClaudeHooks(once, SCRIPT)
    expect(twice).toEqual(once)
    // Exactly one Octopus entry per event.
    const stopCmds = (twice.hooks?.Stop ?? [])
      .flatMap((g) => g.hooks ?? [])
      .filter((h) => h.command.includes(OCTOPUS_HOOK_MARKER))
    expect(stopCmds).toHaveLength(1)
  })

  it('replaces only a stale Octopus entry when the command text drifts (upgrade)', () => {
    // Simulate a prior install whose Octopus command differs from the current one.
    const stale = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command' as const, command: `old-cmd ${OCTOPUS_HOOK_MARKER}` }] }]
      }
    }
    const merged = mergeClaudeHooks(stale, SCRIPT)
    const stopCmds = (merged.hooks?.Stop ?? [])
      .flatMap((g) => g.hooks ?? [])
      .filter((h) => h.command.includes(OCTOPUS_HOOK_MARKER))
    // Still exactly one Octopus entry, and it is the CURRENT command, not the stale one.
    expect(stopCmds).toHaveLength(1)
    expect(stopCmds[0].command).not.toContain('old-cmd')
  })

  it('does not mutate the input object', () => {
    const input = { hooks: {} }
    const snapshot = JSON.stringify(input)
    mergeClaudeHooks(input, SCRIPT)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('mergeStatusLine (§9.2 — save & chain)', () => {
  it('points statusLine.command at the bridge and reports no original when none existed', () => {
    const { settings, savedOriginal } = mergeStatusLine({}, SCRIPT)
    expect(settings.statusLine?.command).toBe(statusLineCommand(SCRIPT))
    expect(settings.statusLine?.type).toBe('command')
    expect(savedOriginal).toBeUndefined()
  })

  it("captures the user's original command as the chain target", () => {
    const { settings, savedOriginal } = mergeStatusLine(
      { statusLine: { type: 'command', command: 'my-bar.sh' } },
      SCRIPT
    )
    expect(savedOriginal).toBe('my-bar.sh')
    expect(settings.statusLine?.command).toBe(statusLineCommand(SCRIPT))
  })

  it('is idempotent — re-wrapping does not recapture our own wrapper as the original', () => {
    const first = mergeStatusLine({ statusLine: { type: 'command', command: 'my-bar.sh' } }, SCRIPT)
    const second = mergeStatusLine(first.settings, SCRIPT)
    expect(second.settings).toEqual(first.settings)
    expect(second.savedOriginal).toBeUndefined()
  })

  it('refreshes a drifted Octopus wrapper without capturing it as the original', () => {
    const stale = {
      statusLine: { type: 'command', command: `python3 old.py statusline ${OCTOPUS_HOOK_MARKER}` }
    }
    const { settings, savedOriginal } = mergeStatusLine(stale, SCRIPT)
    expect(settings.statusLine?.command).toBe(statusLineCommand(SCRIPT))
    expect(savedOriginal).toBeUndefined()
  })
})

describe('hasAllOctopusHooks', () => {
  it('is true once hooks and the statusline wrapper are all present', () => {
    const withHooks = mergeClaudeHooks({}, SCRIPT)
    const { settings } = mergeStatusLine(withHooks, SCRIPT)
    expect(hasAllOctopusHooks(settings, SCRIPT)).toBe(true)
  })

  it('is false when an event is missing its Octopus entry or the statusline is unset', () => {
    expect(hasAllOctopusHooks({}, SCRIPT)).toBe(false)
    expect(hasAllOctopusHooks({ hooks: { Stop: [] } }, SCRIPT)).toBe(false)
    // Hooks present but statusline not yet wrapped.
    expect(hasAllOctopusHooks(mergeClaudeHooks({}, SCRIPT), SCRIPT)).toBe(false)
  })
})
