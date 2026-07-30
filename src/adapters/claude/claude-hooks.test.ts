import { describe, it, expect } from 'vitest'
import {
  mergeClaudeHooks,
  hasAllOctopusHooks,
  hookCommand,
  OCTOPUS_HOOK_MARKER
} from './claude-hooks'

describe('hookCommand (§9.2)', () => {
  it('is guarded on the socket var, never fails the hook, and is tagged', () => {
    const cmd = hookCommand('{"state":"working"}')
    expect(cmd).toContain('$OCTOPUS_STATE_SOCKET')
    expect(cmd).toContain('nc')
    expect(cmd).toContain('-U')
    // -N/-q0 make OpenBSD nc close the socket on stdin EOF instead of hanging ~2min.
    expect(cmd).toContain('-N')
    expect(cmd).toContain(OCTOPUS_HOOK_MARKER)
    // A trailing `true` keeps a missing `nc` / unset var from failing the hook.
    expect(cmd).toContain('true')
  })

  it('single-quote-escapes the JSON payload so the sh literal stays intact', () => {
    const cmd = hookCommand(`{"reason":"it's fine"}`)
    // The apostrophe must be closed-escaped-reopened, never left bare inside '...'.
    expect(cmd).toContain(`'\\''`)
  })
})

describe('mergeClaudeHooks (§9.2 — merge-safe, idempotent)', () => {
  it('adds all Octopus hook events to an empty settings object', () => {
    const merged = mergeClaudeHooks({})
    expect(hasAllOctopusHooks(merged)).toBe(true)
    for (const event of ['Stop', 'Notification', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
      expect(merged.hooks?.[event]).toBeDefined()
    }
  })

  it('preserves an unrelated user key and a user hook entry verbatim', () => {
    const userHook = { hooks: [{ type: 'command' as const, command: 'echo hi' }] }
    const merged = mergeClaudeHooks({
      model: 'opus',
      hooks: { Stop: [userHook] }
    })
    expect(merged.model).toBe('opus')
    // The user's Stop hook survives alongside the appended Octopus one.
    const stop = merged.hooks?.Stop ?? []
    const commands = stop.flatMap((g) => g.hooks ?? []).map((h) => h.command)
    expect(commands).toContain('echo hi')
    expect(commands.some((c) => c.includes(OCTOPUS_HOOK_MARKER))).toBe(true)
  })

  it('is idempotent — re-merging yields deep-equal output (no duplicate Octopus entries)', () => {
    const once = mergeClaudeHooks({})
    const twice = mergeClaudeHooks(once)
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
    const merged = mergeClaudeHooks(stale)
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
    mergeClaudeHooks(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('hasAllOctopusHooks is false when an event is missing its Octopus entry', () => {
    expect(hasAllOctopusHooks({})).toBe(false)
    expect(hasAllOctopusHooks({ hooks: { Stop: [] } })).toBe(false)
  })
})
