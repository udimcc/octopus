/**
 * End-to-end integration for the NEW Claude state source edge (DESIGN §9.6). Unlike
 * the unit tests — which exercise the python bridge and the file-watcher in isolation —
 * this drives the whole out-of-band pipeline the composition root wires:
 *
 *   REAL python3 script (from `ensureClaudeStateScript`) writes a per-session
 *   `<id>.json`  →  REAL `createClaudeStateWatcher` (fs.watch + initial scan) reads it
 *   →  `coreToSessionState` maps it  →  the `sink` receives a domain `SessionState`.
 *
 * This is the replacement for the old socket/composite/detector integration: the
 * runtime/daemon no longer participate in state detection at all (§9.6), so there is
 * no PTY to spawn here — only the script and the watcher, wired exactly as in prod.
 *
 * Skipped (not failed) if python3 is unavailable, mirroring the sibling script suite
 * so the run stays green on a box without it (the target host has /usr/bin/python3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureClaudeStateScript,
  CLAUDE_STATE_DIR_NAME
} from '../../src/adapters/claude/octopus-claude-state.script'
import {
  createClaudeStateWatcher,
  type ClaudeStateWatcher
} from '../../src/adapters/claude/claude-state-watcher'
import { SessionState } from '../../src/domain/state'
import type { StateChangeMeta } from '../../src/ports/session-runtime'

const PYTHON = '/usr/bin/python3'
const hasPython = ((): boolean => {
  try {
    return spawnSync(PYTHON, ['--version']).status === 0
  } catch {
    return false
  }
})()

const d = hasPython ? describe : describe.skip

d('Claude state pipeline (integration, §9.6)', () => {
  let dir: string
  let scriptPath: string
  let stateDir: string
  let watcher: ClaudeStateWatcher | undefined
  const observed: Array<{ sessionId: string; state: SessionState; meta?: StateChangeMeta }> = []
  const SID = 'sess-1'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-state-e2e-'))
    scriptPath = ensureClaudeStateScript(dir)
    stateDir = join(dir, CLAUDE_STATE_DIR_NAME)
    observed.length = 0
  })

  afterEach(() => {
    watcher?.dispose()
    watcher = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  /** Run the bridge with OCTOPUS_SESSION_ID set (so it writes the state file). */
  function bridge(args: string[], input = '{}', sid = SID): void {
    execFileSync(PYTHON, [scriptPath, ...args], {
      input,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', OCTOPUS_SESSION_ID: sid },
      encoding: 'utf8'
    })
  }

  /** A PreToolUse/PostToolUse hook carrying a tool_name (delegation bookkeeping). */
  const toolHook = (event: string, tool: string): void =>
    bridge(['hook', event], JSON.stringify({ tool_name: tool }))

  /** Start a watcher whose sink records every push. Uses a tiny debounce for speed. */
  function startWatcher(): void {
    watcher = createClaudeStateWatcher({
      dir: stateDir,
      debounceMs: 5,
      sink: (sessionId, state, meta) => observed.push({ sessionId, state, meta })
    })
  }

  const last = (sid = SID): SessionState | undefined =>
    observed.filter((o) => o.sessionId === sid).pop()?.state

  async function waitUntil(pred: () => boolean, ms = 4000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred()) return true
      await new Promise((r) => setTimeout(r, 15))
    }
    return pred()
  }

  it('a Stop hook drives the watcher to push Idle', async () => {
    startWatcher()
    bridge(['hook', 'Stop'])
    expect(await waitUntil(() => last() === SessionState.Idle)).toBe(true)
  })

  it('a PermissionRequest hook drives NeedsInput, carrying the reason', async () => {
    startWatcher()
    bridge(['hook', 'UserPromptSubmit']) // open a turn — permission prompts only occur mid-turn
    bridge(['hook', 'PermissionRequest'])
    expect(await waitUntil(() => last() === SessionState.NeedsInput)).toBe(true)
    const push = observed.filter((o) => o.state === SessionState.NeedsInput).pop()
    expect(push?.meta?.reason).toBe('permission')
  })

  it('a PreToolUse hook drives Working', async () => {
    startWatcher()
    bridge(['hook', 'UserPromptSubmit']) // open a turn
    bridge(['hook', 'PreToolUse'])
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)
  })

  it('a stray SubagentStop after Stop does NOT flip a finished session back to Working', async () => {
    // The reported bug, end to end: a late sub-event with no new prompt must not
    // resurrect Working over the terminal Idle (turn gating in the bridge).
    startWatcher()
    bridge(['hook', 'UserPromptSubmit'])
    bridge(['hook', 'Stop'])
    expect(await waitUntil(() => last() === SessionState.Idle)).toBe(true)
    const idleCount = observed.filter((o) => o.state === SessionState.Idle).length
    bridge(['hook', 'SubagentStop']) // stray, out of turn
    // Give the watcher time to (not) fire; the gated write leaves the file untouched,
    // so no new push should arrive and the last state stays Idle.
    await new Promise((r) => setTimeout(r, 200))
    expect(last()).toBe(SessionState.Idle)
    expect(observed.filter((o) => o.state === SessionState.Working)).toHaveLength(0)
    // At most the initial Idle push(es); the stray event produced no file change.
    expect(observed.filter((o) => o.state === SessionState.Idle).length).toBe(idleCount)
  })

  it('mid-tool tool_use does not transiently push NeedsInput while a working hook is in-turn', async () => {
    // A dangling tool_use in the transcript (a tool mid-execution) has the same shape as
    // one awaiting permission. With a fresh in-turn `working` hook, the statusline's
    // transcript-derived `blocked` must NOT surface as NeedsInput (DESIGN §9.7). Without
    // the effective() guard, the newer transcript mtime would win and flip to NeedsInput.
    startWatcher()
    bridge(['hook', 'UserPromptSubmit']) // open a turn
    bridge(['hook', 'PreToolUse']) // working hook
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)

    const transcriptPath = join(dir, 'midtool.jsonl')
    writeFileSync(
      transcriptPath,
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
    bridge(['statusline'], JSON.stringify({ session_id: SID, transcript_path: transcriptPath }))
    // Let any spurious push land, then assert the session stayed Working throughout.
    await new Promise((r) => setTimeout(r, 200))
    expect(last()).toBe(SessionState.Working)
    expect(observed.filter((o) => o.state === SessionState.NeedsInput)).toHaveLength(0)
  })

  it('a subagent run keeps the session Working end to end (counter over a frozen transcript)', async () => {
    // Bug 1: the main agent delegates (PreToolUse(Agent)) and waits. Its transcript
    // freezes with a dangling Agent tool_use; without the delegation counter that reads
    // as done/blocked. The counter must hold the whole session Working until the
    // main agent's Stop, even as the statusline ticks over the frozen transcript.
    startWatcher()
    bridge(['hook', 'UserPromptSubmit'])
    toolHook('PreToolUse', 'Agent')
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)

    const transcriptPath = join(dir, 'subagent.jsonl')
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'ag-1', name: 'Agent' }]
        }
      }) + '\n',
      'utf8'
    )
    bridge(['statusline'], JSON.stringify({ session_id: SID, transcript_path: transcriptPath }))
    await new Promise((r) => setTimeout(r, 200))
    expect(last()).toBe(SessionState.Working)
    expect(observed.filter((o) => o.state === SessionState.Idle)).toHaveLength(0)
    expect(observed.filter((o) => o.state === SessionState.NeedsInput)).toHaveLength(0)
  })

  it('a genuine PermissionRequest during a subagent run still pushes NeedsInput', async () => {
    // The counter yields to a real permission prompt: if a subagent needs approval the
    // user must act, so that is NeedsInput even while a subagent is outstanding.
    startWatcher()
    bridge(['hook', 'UserPromptSubmit'])
    toolHook('PreToolUse', 'Agent')
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)
    bridge(['hook', 'PermissionRequest'])
    expect(await waitUntil(() => last() === SessionState.NeedsInput)).toBe(true)
  })

  it('bug 1: background subagent keeps the session Working across a premature main-agent Stop', async () => {
    // Reproduced end to end from the LIVE hook trace. A background Agent's
    // PreToolUse+PostToolUse fire at launch, then the MAIN agent Stops while the child
    // still runs. The session must stay Working across that premature Stop (Stop defers
    // closing while a subagent is outstanding) and NOT flash Idle mid-run.
    startWatcher()
    bridge(['hook', 'UserPromptSubmit'])
    toolHook('PreToolUse', 'Agent') // launch (subagents -> 1)
    toolHook('PostToolUse', 'Agent') // background launch returns at once; must NOT close
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)
    bridge(['hook', 'Stop']) // main agent yields WHILE the child runs
    // Stop is deferred (subagents > 0): give the watcher time to (not) push Idle.
    await new Promise((r) => setTimeout(r, 200))
    expect(last()).toBe(SessionState.Working)
    expect(observed.filter((o) => o.state === SessionState.Idle)).toHaveLength(0)
  })

  it('fire-and-forget: a background child ending after the main agent Stops drives Idle (no stuck Working)', async () => {
    // The main agent yields while a background child runs and never resumes. When the
    // child ends, the whole session is genuinely done, so the deferred Stop is finalized
    // -> Idle. Without the finalize fix the session would be stuck Working forever (the
    // deferred Stop never re-fires, and the counter override blocks the transcript). §9.7.
    startWatcher()
    bridge(['hook', 'UserPromptSubmit'])
    toolHook('PreToolUse', 'Agent') // launch (subagents -> 1)
    bridge(['hook', 'Stop']) // main agent yields WHILE the child runs (deferred)
    await new Promise((r) => setTimeout(r, 100))
    expect(last()).toBe(SessionState.Working)
    bridge(['hook', 'SubagentStop']) // last child ends -> finalize the deferred Stop
    expect(await waitUntil(() => last() === SessionState.Idle)).toBe(true)
  })

  it('SubagentStart..SubagentStop id-set path holds Working through a deferred Stop, then Idle', async () => {
    // The primary path (when Claude emits SubagentStart): children are tracked by
    // agent_id. Working from SubagentStart through the main agent's premature Stop, then
    // Idle when the last child's SubagentStop finalizes the deferred close. End to end.
    startWatcher()
    bridge(['hook', 'UserPromptSubmit'])
    bridge(['hook', 'SubagentStart'], JSON.stringify({ agent_id: 'a1' }))
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)
    bridge(['hook', 'Stop']) // main agent yields WHILE a1 runs (deferred)
    await new Promise((r) => setTimeout(r, 100))
    expect(last()).toBe(SessionState.Working)
    bridge(['hook', 'SubagentStop'], JSON.stringify({ agent_id: 'a1' })) // a1 ends -> finalize
    expect(await waitUntil(() => last() === SessionState.Idle)).toBe(true)
  })

  it('PreToolUse-before-SubagentStart fire-and-forget: no stuck Working, finalizes to Idle', async () => {
    // Replays the EXACT live-captured ordering: PreToolUse(Agent) fires first (anon fallback
    // ++), THEN SubagentStart latches and tracks the id — so the one child was counted on
    // both paths. Its SubagentStart reclaims the anon increment; when the child ends after a
    // deferred Stop the count reaches 0 and the deferred Stop finalizes. Without the reclaim
    // anon would stay at 1 and the session would be stuck Working forever.
    startWatcher()
    bridge(['hook', 'UserPromptSubmit'])
    toolHook('PreToolUse', 'Agent') // launch: anon -> 1 (latch not yet set)
    bridge(['hook', 'SubagentStart'], JSON.stringify({ agent_id: 'a1' })) // latch + reclaim anon
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)
    bridge(['hook', 'Stop']) // main agent yields WHILE a1 runs (deferred)
    await new Promise((r) => setTimeout(r, 100))
    expect(last()).toBe(SessionState.Working)
    bridge(['hook', 'SubagentStop'], JSON.stringify({ agent_id: 'a1' })) // last child ends -> finalize
    expect(await waitUntil(() => last() === SessionState.Idle)).toBe(true)
  })

  it('resume recovery from a dangling Agent transcript reads Working (no live hooks)', async () => {
    // After --resume the prior process's hooks (and its counter) are gone; only the
    // transcript survives. A dangling delegation tool_use must read Working, not blocked.
    const transcriptPath = join(dir, 'resume-subagent.jsonl')
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'ag-1', name: 'Agent' }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    startWatcher()
    bridge(['statusline'], JSON.stringify({ session_id: SID, transcript_path: transcriptPath }))
    expect(await waitUntil(() => last() === SessionState.Working)).toBe(true)
  })

  it('resume recovery: the initial scan replays a state file written before the watcher starts', async () => {
    // The bridge wrote a state BEFORE the app (and its watcher) came up — as after a
    // restart. The initial scan must replay it so a restored tab shows status at once.
    bridge(['hook', 'Stop'])
    startWatcher()
    // Initial scan emits synchronously on construction — already present, no wait.
    expect(last()).toBe(SessionState.Idle)
  })

  it('a statusline transcript read (end_turn tail) drives Idle end to end', async () => {
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', stop_reason: 'end_turn', content: [] }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    startWatcher()
    bridge(['statusline'], JSON.stringify({ session_id: SID, transcript_path: transcriptPath }))
    expect(await waitUntil(() => last() === SessionState.Idle)).toBe(true)
  })

  it('rescan(sessionId) forces a re-read + push for the refresh affordance (R1)', async () => {
    bridge(['hook', 'UserPromptSubmit']) // open a turn so PreToolUse is honored
    bridge(['hook', 'PreToolUse'])
    startWatcher()
    // Drain the initial-scan push, then rescan and assert a fresh push arrives.
    await waitUntil(() => observed.length > 0)
    observed.length = 0
    watcher!.rescan(SID)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ sessionId: SID, state: SessionState.Working })
  })
})
