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

    it('ignores a dangling tool_use inside an isSidechain record (subagent) => not blocked', () => {
      // A completed main-agent turn (end_turn) plus a subagent sidechain record still
      // holding an unanswered tool_use. The sidechain must be skipped, so the main
      // end_turn tail wins => waiting, NOT the subagent's dangling tool_use => blocked.
      const p = transcript([
        { type: 'user', message: { role: 'user', content: 'hi' } },
        { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
        {
          type: 'assistant',
          isSidechain: true,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'sub-1', name: 'Bash' }]
          }
        }
      ])
      runStatusline(p)
      expect((readState().transcript as Record<string, unknown>).state).toBe('waiting')
    })

    it('a sidechain record does not suppress a genuine main-agent dangling tool_use', () => {
      // Guard against over-skipping: the MAIN agent's dangling tool_use must still count
      // as blocked even when a later sidechain record is present (and itself ignored).
      const p = transcript([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'main-1', name: 'Bash' }]
          }
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sub-1', name: 'Task' }] }
        }
      ])
      runStatusline(p)
      expect((readState().transcript as Record<string, unknown>).state).toBe('blocked')
    })
  })

  // A dangling tool_use in the transcript is ambiguous: a tool merely MID-EXECUTION has
  // the same signature as one awaiting a permission prompt. Because transcript.mtime can
  // advance past the last hook's ts, the transcript's `blocked` would win the
  // newer-observation-wins race and transiently flip a working session to NeedsInput.
  // effective() therefore prefers an in-turn `working` hook over a transcript `blocked`.
  // See DESIGN §9.7 (mid-tool tool_use) / §9.1.
  describe('effective: transcript blocked vs in-turn working hook (§9.7 mid-tool)', () => {
    function danglingTranscript(): string {
      const p = join(dir, 'midtool.jsonl')
      writeFileSync(
        p,
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash' }]
          }
        }) + '\n',
        'utf8'
      )
      return p
    }

    function runStatusline(transcriptPath: string): void {
      run(['statusline'], JSON.stringify({ session_id: SID, transcript_path: transcriptPath }), {
        OCTOPUS_SESSION_ID: SID
      })
    }

    it('mid-tool: an in-turn working hook is preferred over a transcript-derived blocked', () => {
      // Fire the working hook FIRST, then statusline, so transcript.mtime is genuinely
      // newer than hook.ts — without the fix the transcript `blocked` would win.
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID }) // open a turn
      run(['hook', 'PreToolUse'], '{}', { OCTOPUS_SESSION_ID: SID })
      runStatusline(danglingTranscript())
      const data = readState()
      // The raw transcript observation is unchanged (still blocked)...
      expect((data.transcript as Record<string, unknown>).state).toBe('blocked')
      // ...but the effective state stays working (the in-turn working hook wins).
      expect(data.state).toBe('working')
    })

    it('a genuine blocked hook (PermissionRequest) still wins over the transcript', () => {
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID })
      run(['hook', 'PermissionRequest'], '{}', { OCTOPUS_SESSION_ID: SID })
      runStatusline(danglingTranscript())
      // hook.state is `blocked`, not `working`, so the guard is inert => stays blocked.
      expect(readState().state).toBe('blocked')
    })

    it('resume path: transcript blocked with no in-turn working hook stays blocked', () => {
      // No hooks at all — the guard cannot fire (hook is None), so the transcript wins.
      runStatusline(danglingTranscript())
      expect(readState().state).toBe('blocked')
    })

    it('closed turn (after Stop) does not let a working hook override transcript blocked', () => {
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID })
      run(['hook', 'PreToolUse'], '{}', { OCTOPUS_SESSION_ID: SID })
      run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID }) // closes the turn; hook -> waiting
      runStatusline(danglingTranscript())
      // Turn is closed and hook.state is `waiting` (not working), so the guard is inert.
      // Newer-observation-wins then applies to the transcript vs the Stop hook normally.
      expect((readState().transcript as Record<string, unknown>).state).toBe('blocked')
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

  // Subagent (Task/Agent tool) awareness. The whole session -- main agent + any
  // subagents it launches -- is one unit: Working while EITHER is active. A subagent's
  // life is bracketed by PreToolUse(Task|Agent) (++, at launch) .. SubagentStop (--, at
  // true completion). A BACKGROUND subagent's PostToolUse(Agent) fires at LAUNCH (not
  // completion), so it must NOT drive the counter. The main agent's Stop DEFERS closing
  // the turn while any subagent is outstanding, so the session stays Working across a
  // premature Stop and does not flash Idle. See DESIGN §9.2 / §9.7.
  describe('subagent delegation (Agent/Task)', () => {
    function transcript(lines: object[]): string {
      const p = join(dir, 'deleg.jsonl')
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
      return p
    }
    const danglingTool = (name: string, id = 'tu-1'): object => ({
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name }]
      }
    })
    function runStatusline(transcriptPath: string): void {
      run(['statusline'], JSON.stringify({ session_id: SID, transcript_path: transcriptPath }), {
        OCTOPUS_SESSION_ID: SID
      })
    }
    const pre = (tool: string): void => {
      run(['hook', 'PreToolUse'], JSON.stringify({ tool_name: tool }), { OCTOPUS_SESSION_ID: SID })
    }
    const post = (tool: string): void => {
      run(['hook', 'PostToolUse'], JSON.stringify({ tool_name: tool }), { OCTOPUS_SESSION_ID: SID })
    }
    const subagentStop = (): void => {
      run(['hook', 'SubagentStop'], '{}', { OCTOPUS_SESSION_ID: SID })
    }
    const stop = (): void => {
      run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
    }
    const prompt = (): void => {
      run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID })
    }

    it('dangling Agent tool_use tail => working (not blocked)', () => {
      runStatusline(transcript([danglingTool('Agent')]))
      expect((readState().transcript as Record<string, unknown>).state).toBe('working')
    })

    it('dangling Task tool_use tail => working (historical name)', () => {
      runStatusline(transcript([danglingTool('Task')]))
      expect((readState().transcript as Record<string, unknown>).state).toBe('working')
    })

    it('mixed dangling Agent + Bash tail => blocked', () => {
      runStatusline(
        transcript([
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 'a-1', name: 'Agent' },
                { type: 'tool_use', id: 'b-1', name: 'Bash' }
              ]
            }
          }
        ])
      )
      expect((readState().transcript as Record<string, unknown>).state).toBe('blocked')
    })

    it('PreToolUse(Agent) increments the counter and forces working over a transcript blocked', () => {
      prompt()
      pre('Agent')
      // A dangling BASH transcript reads blocked (delegation-aware inference is out of
      // the way), so only the counter can hold the session working.
      runStatusline(transcript([danglingTool('Bash')]))
      const data = readState()
      expect((data.transcript as Record<string, unknown>).state).toBe('blocked')
      expect(data.subagents).toBe(1)
      expect(data.state).toBe('working')
    })

    it('counter increments on PreToolUse(Agent), decrements on SubagentStop, across parallel subagents', () => {
      prompt()
      pre('Agent')
      pre('Agent')
      pre('Agent')
      expect(readState().subagents).toBe(3)
      expect(readState().state).toBe('working')
      subagentStop()
      subagentStop()
      expect(readState().subagents).toBe(1)
      expect(readState().state).toBe('working')
      subagentStop()
      expect(readState().subagents).toBe(0)
    })

    it('PostToolUse(Agent) does NOT move the counter (background launch fires it early)', () => {
      // A background subagent's PostToolUse(Agent) fires at LAUNCH, not completion, so
      // it must not close the bracket -- only SubagentStop does.
      prompt()
      pre('Agent')
      post('Agent')
      expect(readState().subagents).toBe(1)
    })

    it('SubagentStop decrement floors at zero', () => {
      prompt()
      subagentStop()
      expect(readState().subagents).toBe(0)
    })

    it('a non-delegation tool does not move the counter', () => {
      prompt()
      pre('Bash')
      post('Bash')
      expect(readState().subagents).toBe(0)
    })

    it('bug 1: Stop while a background child runs stays working (deferred, turn not closed)', () => {
      // Background Agent: Pre+Post fire at launch, then the MAIN agent Stops while the
      // child still runs -> must stay Working (Stop defers closing while subagents > 0)
      // and record that a Stop is pending (stop_deferred) without closing the turn.
      prompt()
      pre('Agent') // launch (subagents -> 1)
      post('Agent') // background launch returns immediately; must NOT decrement
      expect(readState().subagents).toBe(1)
      stop() // main agent yields while child still runs
      const data = readState()
      expect(data.subagents).toBe(1) // NOT zeroed
      expect(data.state).toBe('working') // NOT waiting -- Stop deferred
      expect(data.turn_end_ts).toBeUndefined() // deferred Stop never closed the turn
      expect(data.stop_deferred).toBe(true) // ...but it is remembered for finalization
    })

    it('fire-and-forget: SubagentStop after a deferred Stop finalizes to waiting (no stuck Working)', () => {
      // The main agent Stopped (yielded) while a background child ran, and never resumes.
      // When the LAST child ends, the whole session (main + sub-calls) is genuinely done,
      // so the deferred Stop is finalized here -> waiting/Idle. Without this the session
      // would be stuck Working forever (the deferred Stop never re-fires). See DESIGN §9.7.
      prompt()
      pre('Agent') // subagents -> 1
      stop() // deferred (child still running)
      expect(readState().state).toBe('working')
      subagentStop() // last child ends -> finalize the deferred Stop
      const data = readState()
      expect(data.subagents).toBe(0)
      expect(data.state).toBe('waiting') // Idle: the whole session is finished
      expect(data.turn_end_ts).toBeDefined() // the turn is now closed
      expect(data.stop_deferred).toBe(false) // and the pending-Stop flag cleared
    })

    it('multiple background children: turn finalizes only when the LAST one ends after a deferred Stop', () => {
      prompt()
      pre('Agent') // subagents -> 1
      pre('Agent') // subagents -> 2
      stop() // deferred (2 children still running)
      expect(readState().state).toBe('working')
      subagentStop() // subagents -> 1, one child still runs -> NOT finalized
      let data = readState()
      expect(data.subagents).toBe(1)
      expect(data.state).toBe('working')
      expect(data.turn_end_ts).toBeUndefined()
      subagentStop() // subagents -> 0, last child -> finalize
      data = readState()
      expect(data.subagents).toBe(0)
      expect(data.state).toBe('waiting')
    })

    it('SubagentStop with NO pending Stop stays working (main agent still active, no premature close)', () => {
      // The main agent is still working (has not Stopped): a child completing must not
      // close the turn -- stop_deferred is false, so SubagentStop only decrements. This
      // is the case the deferred-Stop model must NOT confuse with fire-and-forget.
      prompt()
      pre('Agent') // subagents -> 1
      subagentStop() // child ends but the main agent never Stopped
      const data = readState()
      expect(data.subagents).toBe(0)
      expect(data.state).toBe('working') // still the main agent's turn
      expect(data.turn_end_ts).toBeUndefined() // no Stop was pending -> turn stays open
    })

    it('Stop with no outstanding subagent closes normally to waiting', () => {
      prompt()
      pre('Agent')
      subagentStop() // child done first (subagents -> 0)
      expect(readState().subagents).toBe(0)
      stop()
      expect(readState().state).toBe('waiting')
    })

    it('UserPromptSubmit resets a leaked subagent counter to zero', () => {
      prompt()
      pre('Agent')
      pre('Agent')
      prompt() // new turn, counter self-heals even without any SubagentStop
      expect(readState().subagents).toBe(0)
      expect(readState().state).toBe('working')
    })

    it('SubagentStop mid-turn stays working and decrements the counter', () => {
      prompt()
      pre('Agent')
      subagentStop()
      const data = readState()
      expect(data.state).toBe('working')
      expect(data.subagents).toBe(0) // SubagentStop is the close bracket now
    })

    it('a stray SubagentStop after a clean Stop does NOT resurrect Working', () => {
      // No outstanding child at Stop -> turn closes to waiting. A later stray
      // SubagentStop is out-of-turn, so its write is gated out and waiting stands.
      prompt()
      stop()
      expect(readState().state).toBe('waiting')
      subagentStop()
      expect(readState().state).toBe('waiting')
    })

    it('genuine PermissionRequest wins over an outstanding subagent counter', () => {
      prompt()
      pre('Agent')
      run(['hook', 'PermissionRequest'], '{}', { OCTOPUS_SESSION_ID: SID })
      expect(readState().state).toBe('blocked')
      // A statusline tick over a dangling delegation transcript must not undo it.
      runStatusline(transcript([danglingTool('Agent')]))
      expect(readState().state).toBe('blocked')
    })

    it('outstanding counter does not revive a closed (post-Stop) turn', () => {
      // Hand-write a file with a leaked counter but a CLOSED turn (end > start): the
      // effective() override is turn-gated, so it must stay waiting, not go working.
      writeFileSync(
        join(stateDir, SID + '.json'),
        JSON.stringify({
          state: 'waiting',
          reason: 'claude_stop',
          subagents: 2,
          turn_start_ts: 1,
          turn_end_ts: 2,
          hook: { state: 'waiting', reason: 'claude_stop', ts: 2, event: 'Stop' }
        }),
        'utf8'
      )
      expect(run(['get', SID], '', { OCTOPUS_SESSION_ID: SID }).trim()).toBe('waiting')
    })

    it('legacy file without a subagents field: override inert, no crash', () => {
      writeFileSync(
        join(stateDir, SID + '.json'),
        JSON.stringify({
          state: 'working',
          reason: 'pre_tool_use',
          turn_start_ts: 2,
          turn_end_ts: 1,
          hook: { state: 'working', reason: 'pre_tool_use', ts: 2, event: 'PreToolUse' },
          transcript: { state: 'blocked', reason: 'transcript', mtime: 3 }
        }),
        'utf8'
      )
      // No subagents key => override inert; the §9.7 in-turn-working-vs-transcript-blocked
      // guard still applies, so it reads working.
      expect(run(['get', SID], '', { OCTOPUS_SESSION_ID: SID }).trim()).toBe('working')
    })

    // The PRIMARY subagent-tracking path: SubagentStart..SubagentStop paired by agent_id.
    // Both events carry agent_id (verified from live payloads), so outstanding children
    // are an id SET immune to duplicate/stray stops. SubagentStart LATCHES the capability
    // so PreToolUse stops counting (no double-count). See DESIGN §9.1/§9.2.
    describe('SubagentStart..SubagentStop id-set path (primary)', () => {
      const prompt = (): void => {
        run(['hook', 'UserPromptSubmit'], '{}', { OCTOPUS_SESSION_ID: SID })
      }
      const start = (id: string): void => {
        run(['hook', 'SubagentStart'], JSON.stringify({ agent_id: id }), {
          OCTOPUS_SESSION_ID: SID
        })
      }
      const stopId = (id: string): void => {
        run(['hook', 'SubagentStop'], JSON.stringify({ agent_id: id }), { OCTOPUS_SESSION_ID: SID })
      }
      const stop = (): void => {
        run(['hook', 'Stop'], '{}', { OCTOPUS_SESSION_ID: SID })
      }
      const pre = (tool: string): void => {
        run(['hook', 'PreToolUse'], JSON.stringify({ tool_name: tool }), { OCTOPUS_SESSION_ID: SID })
      }

      it('SubagentStart tracks by agent_id and forces working; SubagentStop clears it', () => {
        prompt()
        start('a1')
        let data = readState()
        expect(data.subagent_ids).toEqual(['a1'])
        expect(data.has_subagent_start).toBe(true)
        expect(data.state).toBe('working')
        stopId('a1')
        data = readState()
        expect(data.subagent_ids).toEqual([])
        expect(data.state).toBe('working') // turn still open, main agent still active
      })

      it('parallel subagents: the id set holds all, session working until the LAST clears', () => {
        prompt()
        start('a1')
        start('a2')
        start('a3')
        expect(readState().subagent_ids).toEqual(['a1', 'a2', 'a3'])
        stopId('a2')
        expect(readState().subagent_ids).toEqual(['a1', 'a3'])
        expect(readState().state).toBe('working')
        stopId('a1')
        stopId('a3')
        expect(readState().subagent_ids).toEqual([])
      })

      it('once SubagentStart has latched, PreToolUse(Agent) does NOT also count (no double-count)', () => {
        prompt()
        start('a1') // latches has_subagent_start
        pre('Agent') // must be ignored now — the launch is already in the id set
        const data = readState()
        expect(data.subagent_ids).toEqual(['a1'])
        expect(data.subagents).toBe(0)
      })

      it('a duplicate/stray SubagentStop for an unknown id cannot under-count a live child', () => {
        prompt()
        start('a1')
        stopId('a1') // clears a1
        start('a2') // a real, still-live child
        stopId('a1') // stray/duplicate close for the already-gone a1 — must be a no-op
        const data = readState()
        expect(data.subagent_ids).toEqual(['a2']) // a2 still tracked
        expect(data.state).toBe('working')
      })

      it('fire-and-forget on the id-set path: SubagentStop after a deferred Stop finalizes to waiting', () => {
        prompt()
        start('a1')
        stop() // deferred (a1 still outstanding)
        expect(readState().state).toBe('working')
        expect(readState().stop_deferred).toBe(true)
        stopId('a1') // last child ends -> finalize
        const data = readState()
        expect(data.subagent_ids).toEqual([])
        expect(data.state).toBe('waiting')
        expect(data.turn_end_ts).toBeDefined()
      })

      it('PreToolUse BEFORE SubagentStart: the latch reclaims the pre-latch anon increment (no double-count)', () => {
        // The live-observed ordering: PreToolUse(Agent) fires and increments the anon
        // fallback (has_subagent_start not yet set), THEN SubagentStart latches and adds
        // the id. Without reclaim this reads subagent_count == 2 for ONE child. The
        // SubagentStart branch decrements the paired anon increment so the count is 1.
        prompt()
        pre('Agent') // anon -> 1 (latch not yet set)
        expect(readState().subagents).toBe(1)
        start('a1') // latches + tracks id + reclaims the anon increment
        const data = readState()
        expect(data.subagent_ids).toEqual(['a1'])
        expect(data.subagents).toBe(0) // reclaimed — the single launch is counted once
      })

      it('PreToolUse-before-SubagentStart fire-and-forget still finalizes (no anon left stuck at 1)', () => {
        // The stuck-Working risk the reclaim closes: pre-latch double-count + a child
        // that outlives the main agent. SubagentStop clears the id; if anon were left at
        // 1, subagent_count would never reach 0 and the deferred Stop would never
        // finalize. With reclaim, count hits 0 and the session goes waiting.
        prompt()
        pre('Agent') // anon -> 1
        start('a1') // reclaim -> anon 0, id set {a1}
        stop() // deferred (a1 outstanding)
        expect(readState().state).toBe('working')
        stopId('a1') // last child ends -> finalize
        const data = readState()
        expect(data.subagent_ids).toEqual([])
        expect(data.subagents).toBe(0)
        expect(data.state).toBe('waiting')
      })

      it('SubagentStart with no agent_id falls back to the anonymous counter (still counted)', () => {
        prompt()
        run(['hook', 'SubagentStart'], '{}', { OCTOPUS_SESSION_ID: SID }) // latch, no id
        const data = readState()
        expect(data.has_subagent_start).toBe(true)
        expect(data.subagents).toBe(1) // anonymous fallback kept the launch counted
        expect(data.state).toBe('working')
      })

      it('UserPromptSubmit clears the id set but NOT the has_subagent_start latch', () => {
        prompt()
        start('a1')
        prompt() // new turn
        const data = readState()
        expect(data.subagent_ids).toEqual([])
        expect(data.has_subagent_start).toBe(true) // capability persists across turns
      })
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
