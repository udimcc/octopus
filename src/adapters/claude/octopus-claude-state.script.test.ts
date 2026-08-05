/**
 * Exercises the REAL python3 bridge (not a TS mirror) by writing it to a temp dir and
 * shelling out — so the logic that actually ships is what's tested, inside the normal
 * `npm run test` run. Skips gracefully if python3 is unavailable (it is present on the
 * target host at /usr/bin/python3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureClaudeStateScript,
  CLAUDE_STATE_DIR_NAME,
  ORIGINAL_STATUSLINE_FILE
} from './octopus-claude-state.script'

const PYTHON = '/usr/bin/python3'
const hasPython = ((): boolean => {
  try {
    return spawnSync(PYTHON, ['--version']).status === 0
  } catch {
    return false
  }
})()

describe.skipIf(!hasPython)('octopus-claude-state.py', () => {
  let dir: string
  let scriptPath: string
  let stateDir: string
  const SID = 'sess-1'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-pyscript-'))
    scriptPath = ensureClaudeStateScript(dir)
    stateDir = join(dir, CLAUDE_STATE_DIR_NAME)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Run the script with an env + stdin; return stdout. Starts from a CLEAN env (the
   * test runner itself runs inside an Octopus session, so inheriting `process.env`
   * would leak a real `OCTOPUS_SESSION_ID` into the "unset" cases). PATH is preserved
   * so the delegated `sh -c` can find `printf`.
   */
  function run(args: string[], input: string, env: Record<string, string> = {}): string {
    return execFileSync(PYTHON, [scriptPath, ...args], {
      input,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      encoding: 'utf8'
    })
  }

  function readState(sid = SID): Record<string, unknown> {
    return JSON.parse(readFileSync(join(stateDir, sid + '.json'), 'utf8'))
  }

  it('ensureClaudeStateScript writes the script and the claude-state dir', () => {
    expect(existsSync(scriptPath)).toBe(true)
    expect(existsSync(stateDir)).toBe(true)
  })

  it('maps hook events to states', () => {
    // Turn-boundary events (start/end) always record. The WITHIN-turn observations
    // (working/blocked sub-events) are honored only while a turn is open, so open one
    // with UserPromptSubmit before each — see the gating tests below for the closed case.
    const cases: Array<[string, string, string]> = [
      ['Stop', 'waiting', 'claude_stop'],
      ['StopFailure', 'waiting', 'stop_failure'],
      ['UserPromptSubmit', 'working', 'user_prompt']
    ]
    for (const [event, state, reason] of cases) {
      run(['hook', event], '{}', { OCTOPUS_SESSION_ID: SID })
      const data = readState()
      expect(data.state).toBe(state)
      expect((data.hook as Record<string, unknown>).reason).toBe(reason)
    }

    const withinTurn: Array<[string, string, string]> = [
      ['PermissionRequest', 'blocked', 'permission'],
      ['SubagentStop', 'working', 'subagent_stop'],
      ['PreToolUse', 'working', 'pre_tool_use'],
      ['PostToolUse', 'working', 'tool_use']
    ]
    for (const [event, state, reason] of withinTurn) {
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID }) // (re)open a turn
      run(['hook', event], '{}', { OCTOPUS_SESSION_ID: SID })
      const data = readState()
      expect(data.state).toBe(state)
      expect((data.hook as Record<string, unknown>).reason).toBe(reason)
    }
  })

  it('Notification without the idle marker maps to blocked (mid-turn)', () => {
    run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID }) // open a turn
    run(['hook', 'Notification'], JSON.stringify({ message: 'Claude needs your permission' }), {
      OCTOPUS_SESSION_ID: SID
    })
    expect(readState().state).toBe('blocked')
  })

  it('suppresses the idle "waiting for your input" Notification', () => {
    // First a Stop -> waiting, then the idle reminder must NOT overwrite it.
    run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
    run(['hook', 'Notification'], JSON.stringify({ message: 'Claude is waiting for your input' }), {
      OCTOPUS_SESSION_ID: SID
    })
    const data = readState()
    expect(data.state).toBe('waiting')
    // No blocked hook observation was recorded.
    expect((data.hook as Record<string, unknown>).state).toBe('waiting')
  })

  it('does not write a state file when OCTOPUS_SESSION_ID is unset', () => {
    run(['hook', 'Stop'], '{}', {})
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })

  it('leaves no temp file after an atomic write', () => {
    run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
    expect(readdirSync(stateDir).filter((f) => f.includes('.tmp.'))).toHaveLength(0)
  })

  describe('statusline transcript derivation', () => {
    function transcript(lines: object[]): string {
      const p = join(dir, 'transcript.jsonl')
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
      return p
    }

    function runStatusline(transcriptPath: string): void {
      run(['statusline'], JSON.stringify({ session_id: SID, transcript_path: transcriptPath }), {
        OCTOPUS_SESSION_ID: SID
      })
    }

    it('end_turn tail => waiting', () => {
      const p = transcript([
        { type: 'user', message: { role: 'user', content: 'hi' } },
        { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }
      ])
      runStatusline(p)
      const data = readState()
      expect((data.transcript as Record<string, unknown>).state).toBe('waiting')
      expect(data.state).toBe('waiting')
    })

    it('dangling tool_use tail => blocked', () => {
      const p = transcript([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash' }]
          }
        }
      ])
      runStatusline(p)
      expect((readState().transcript as Record<string, unknown>).state).toBe('blocked')
    })

    it('answered tool_use (result present) then ongoing => working', () => {
      const p = transcript([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash' }]
          }
        },
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] }
        }
      ])
      runStatusline(p)
      expect((readState().transcript as Record<string, unknown>).state).toBe('working')
    })
  })

  it('statusline delegates to the saved original command and echoes its stdout', () => {
    // Save an original statusline that echoes a marker.
    writeFileSync(join(stateDir, ORIGINAL_STATUSLINE_FILE), 'printf ORIGINAL_BAR', 'utf8')
    const out = run(['statusline'], JSON.stringify({ session_id: SID, transcript_path: '' }), {
      OCTOPUS_SESSION_ID: SID
    })
    expect(out).toContain('ORIGINAL_BAR')
  })

  it('statusline still delegates when OCTOPUS_SESSION_ID is unset (no file written)', () => {
    writeFileSync(join(stateDir, ORIGINAL_STATUSLINE_FILE), 'printf PLAIN_BAR', 'utf8')
    const out = run(['statusline'], JSON.stringify({ session_id: 'x', transcript_path: '' }), {})
    expect(out).toContain('PLAIN_BAR')
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })

  describe('effective state: newer observation wins', () => {
    it('a fresh hook overrides an older transcript observation', () => {
      // Seed a transcript observation via statusline (waiting), then fire a working hook.
      const p = join(dir, 't.jsonl')
      writeFileSync(
        p,
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', stop_reason: 'end_turn', content: [] }
        }) + '\n',
        'utf8'
      )
      run(['statusline'], JSON.stringify({ session_id: SID, transcript_path: p }), {
        OCTOPUS_SESSION_ID: SID
      })
      expect(readState().state).toBe('waiting')
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID }) // open a turn
      run(['hook', 'PreToolUse'], '{}', { OCTOPUS_SESSION_ID: SID })
      // The hook fired at now >= transcript mtime, so it wins.
      expect(readState().state).toBe('working')
    })
  })

  // The reported bug: after a turn ends (Stop -> waiting) a stray "working" sub-event
  // (SubagentStop/PreToolUse/PostToolUse arriving minutes later with NO new prompt) must
  // NOT resurrect `working`. A turn opens on UserPromptSubmit and closes on Stop; only
  // within-turn observations are honored, so an out-of-turn one is dropped entirely.
  describe('turn gating: out-of-turn sub-events cannot revive an ended turn (§9.6 bug)', () => {
    for (const stray of ['SubagentStop', 'PreToolUse', 'PostToolUse']) {
      it(`Stop then a stray ${stray} stays waiting (does not flip to working)`, () => {
        run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
        expect(readState().state).toBe('waiting')

        run(['hook', stray], '{}', { OCTOPUS_SESSION_ID: SID })
        const data = readState()
        expect(data.state).toBe('waiting')
        // The hook slot still holds the terminal Stop observation — the stray was dropped.
        expect((data.hook as Record<string, unknown>).event).toBe('Stop')
        expect((data.hook as Record<string, unknown>).state).toBe('waiting')
      })
    }

    it('Stop then a stray PermissionRequest/Notification stays waiting', () => {
      run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
      run(['hook', 'PermissionRequest'], '{}', { OCTOPUS_SESSION_ID: SID })
      expect(readState().state).toBe('waiting')
      run(['hook', 'Notification'], JSON.stringify({ message: 'Claude needs your permission' }), {
        OCTOPUS_SESSION_ID: SID
      })
      expect(readState().state).toBe('waiting')
    })

    it('SubagentStop mid-turn IS working (regression: the prior fix must hold)', () => {
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID })
      run(['hook', 'SubagentStop'], '{}', { OCTOPUS_SESSION_ID: SID })
      const data = readState()
      expect(data.state).toBe('working')
      expect((data.hook as Record<string, unknown>).reason).toBe('subagent_stop')
    })

    it('UserPromptSubmit reopens a turn so subsequent sub-events are honored again', () => {
      run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
      expect(readState().state).toBe('waiting')
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID }) // reopen
      run(['hook', 'SubagentStop'], '{}', { OCTOPUS_SESSION_ID: SID })
      expect(readState().state).toBe('working')
    })

    it('legacy file with no turn fields is treated as closed (backward compat)', () => {
      // A file written by the pre-fix script: has hook/state but no turn_start_ts.
      writeFileSync(
        join(stateDir, SID + '.json'),
        JSON.stringify({
          state: 'waiting',
          reason: 'claude_stop',
          hook: { state: 'waiting', reason: 'claude_stop', ts: 1, event: 'Stop' }
        }),
        'utf8'
      )
      run(['hook', 'SubagentStop'], '{}', { OCTOPUS_SESSION_ID: SID })
      expect(readState().state).toBe('waiting')
    })

    it('the transcript backstop still reads working during real work after a drop', () => {
      // Turn ended; a stray SubagentStop is dropped (stays waiting)...
      run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
      run(['hook', 'SubagentStop'], '{}', { OCTOPUS_SESSION_ID: SID })
      expect(readState().state).toBe('waiting')
      // ...but if work is genuinely ongoing, the statusline's transcript read (mtime=now)
      // still surfaces working via the independent backstop — gating didn't defeat it.
      const p = join(dir, 'ongoing.jsonl')
      writeFileSync(
        p,
        [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash' }]
            }
          }),
          // The tool_use is answered => no dangling; not an end_turn tail => working.
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] }
          })
        ].join('\n') + '\n',
        'utf8'
      )
      run(['statusline'], JSON.stringify({ session_id: SID, transcript_path: p }), {
        OCTOPUS_SESSION_ID: SID
      })
      expect(readState().state).toBe('working')
    })
  })

  it('get prints the effective state', () => {
    run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID }) // open a turn
    run(['hook', 'PostToolUse'], '{}', { OCTOPUS_SESSION_ID: SID })
    const out = run(['get', SID], '', { OCTOPUS_SESSION_ID: SID }).trim()
    expect(out).toBe('working')
  })

  it('get prints unknown for a session with no file', () => {
    expect(run(['get', 'nope'], '').trim()).toBe('unknown')
  })
})
