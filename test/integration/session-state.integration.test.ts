/**
 * End-to-end integration for the Claude state source edge (DESIGN §9.3, §9.6). Unlike
 * the unit tests — which exercise the recorder, the fold and the watcher in isolation —
 * this drives the whole out-of-band pipeline the composition root wires:
 *
 *   REAL python3 recorder (from `ensureClaudeStateScript`) appends to
 *   `<id>.events.jsonl`  →  REAL `createClaudeStateWatcher` (real `fs.watch`) folds it
 *   →  the `sink` receives each resolved domain `SessionState` change.
 *
 * Each step waits for the expected state before the next one, because the recorder is
 * run synchronously (which blocks the event loop the watcher runs on).
 *
 * Skipped (not failed) if python3 is unavailable, mirroring the sibling script suite
 * so the run stays green on a box without it (the target host has /usr/bin/python3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureClaudeStateScript,
  CLAUDE_STATE_DIR_NAME,
  EVENTS_FILE_SUFFIX
} from '../../src/adapters/claude/octopus-claude-state.script'
import {
  createClaudeStateWatcher,
  type ClaudeStateWatcher
} from '../../src/adapters/claude/claude-state-watcher'
import { SessionState } from '../../src/domain/state'

const PYTHON = '/usr/bin/python3'
const hasPython = ((): boolean => {
  try {
    return spawnSync(PYTHON, ['--version']).status === 0
  } catch {
    return false
  }
})()

const { Unknown, Idle, Working, NeedsInput } = SessionState

describe.skipIf(!hasPython)('Claude state pipeline (integration, §9.3)', () => {
  let dir: string
  let scriptPath: string
  let stateDir: string
  let watcher: ClaudeStateWatcher | undefined
  let observed: Array<{ sessionId: string; state: SessionState; reason?: string }>
  const SID = 'sess-1'
  const CONV = 'conv-1'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-state-e2e-'))
    scriptPath = ensureClaudeStateScript(dir)
    stateDir = join(dir, CLAUDE_STATE_DIR_NAME)
    observed = []
  })

  afterEach(() => {
    watcher?.dispose()
    watcher = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  /** Run one hook through the real recorder, as Claude would inside session `sid`. */
  function hook(event: string, payload: Record<string, unknown> = {}, sid = SID): void {
    execFileSync(PYTHON, [scriptPath, 'hook', event], {
      input: JSON.stringify({ session_id: CONV, prompt_id: 'p1', ...payload }),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', OCTOPUS_SESSION_ID: sid },
      encoding: 'utf8'
    })
  }

  const launchBackground = (id: string): void => {
    const tool = { tool_name: 'Agent', tool_use_id: `tu-${id}`, tool_input: { prompt: id } }
    hook('PreToolUse', tool)
    hook('SubagentStart', { agent_id: id, agent_type: 'general-purpose' })
    hook('PostToolUse', {
      ...tool,
      tool_response: { isAsync: true, status: 'async_launched', agentId: id }
    })
  }
  const running = (...ids: string[]): Array<Record<string, string>> =>
    ids.map((id) => ({ id, type: 'subagent', status: 'running' }))
  const wake = (id: string, prm: string): void =>
    hook('UserPromptSubmit', {
      prompt_id: prm,
      prompt: `<task-notification>\n<task-id>${id}</task-id>\n</task-notification>`
    })

  function startWatcher(track: 'attach' | 'reset' = 'attach'): ClaudeStateWatcher {
    watcher = createClaudeStateWatcher({
      dir: stateDir,
      debounceMs: 5,
      sink: (sessionId, state, meta) => observed.push({ sessionId, state, reason: meta?.reason })
    })
    watcher[track](SID)
    return watcher
  }

  const states = (sid = SID): SessionState[] =>
    observed.filter((o) => o.sessionId === sid).map((o) => o.state)
  const last = (sid = SID): SessionState | undefined => states(sid).pop()

  async function reach(state: SessionState, ms = 4000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < ms && last() !== state) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(last()).toBe(state)
  }
  const quiet = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('a plain turn: prompt → Working, permission → NeedsInput, answered → Working, Stop → Idle', async () => {
    startWatcher()
    hook('SessionStart', { source: 'startup' })
    await reach(Idle)
    hook('UserPromptSubmit', { prompt: 'hi' })
    await reach(Working)
    const bash = { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' } }
    hook('PreToolUse', bash)
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    await reach(NeedsInput)
    expect(observed[observed.length - 1].reason).toMatch(/^permission/)
    hook('PostToolUse', bash)
    await reach(Working)
    hook('Stop', { background_tasks: [] })
    await reach(Idle)
    expect(states()).toEqual([Idle, Working, NeedsInput, Working, Idle])
  })

  it('bug 1: one of two background agents finishing keeps the session Working', async () => {
    startWatcher()
    hook('UserPromptSubmit', { prompt: 'launch two' })
    launchBackground('A')
    launchBackground('B')
    hook('Stop', { background_tasks: running('A', 'B') })
    await reach(Working)
    hook('SubagentStop', { agent_id: 'A', background_tasks: running('A', 'B') })
    wake('A', 'p2')
    hook('Stop', { prompt_id: 'p2', background_tasks: running('B') })
    await quiet()
    expect(states()).toEqual([Working])
    hook('SubagentStop', { agent_id: 'B', background_tasks: running('B') })
    wake('B', 'p3')
    hook('Stop', { prompt_id: 'p3', background_tasks: [] })
    await reach(Idle)
    expect(states()).toEqual([Working, Idle])
  })

  it('bug 2: no Idle blip between a subagent finishing and its result being picked up', async () => {
    startWatcher()
    hook('UserPromptSubmit', { prompt: 'launch one' })
    launchBackground('A')
    hook('Stop', { background_tasks: running('A') })
    await reach(Working)
    hook('SubagentStop', { agent_id: 'A', background_tasks: running('A') })
    await quiet() // the gap before Claude's task-notification wake-up
    expect(states()).toEqual([Working])
    wake('A', 'p2')
    await quiet()
    hook('Stop', { prompt_id: 'p2', background_tasks: [] })
    await reach(Idle)
    expect(states()).toEqual([Working, Idle])
  })

  it('a fresh terminal (reset) drops the previous Claude’s log and starts Unknown', async () => {
    hook('UserPromptSubmit', { prompt: 'left running when the app quit' })
    const log = join(stateDir, SID + EVENTS_FILE_SUFFIX)
    expect(existsSync(log)).toBe(true)
    startWatcher('reset')
    expect(existsSync(log)).toBe(false)
    await quiet()
    expect(states()).toEqual([])
    hook('SessionStart', { source: 'startup' })
    await reach(Idle)
  })

  it('a re-attach (attach) replays the log and shows the live state at once', async () => {
    hook('UserPromptSubmit', { prompt: 'still running' })
    launchBackground('A')
    hook('Stop', { background_tasks: running('A') })
    startWatcher('attach')
    expect(states()).toEqual([Working])
    expect(observed[0].reason).toMatch(/^subagents_running:1/)
  })

  it('a session the watcher does not track is ignored; SessionEnd clears the icon', async () => {
    startWatcher()
    hook('UserPromptSubmit', { prompt: 'x' }, 'other')
    hook('UserPromptSubmit', { prompt: 'y' })
    await reach(Working)
    hook('SessionEnd', { reason: 'prompt_input_exit' })
    await reach(Unknown)
    expect(states('other')).toEqual([])
  })

  it('a denied permission (no hook fires) is ended by the transcript’s interrupt marker', async () => {
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(transcript, '')
    startWatcher()
    hook('UserPromptSubmit', { prompt: 'rm it', transcript_path: transcript })
    const rm = { tool_name: 'Bash', tool_use_id: 'r1', tool_input: { command: 'rm x' } }
    hook('PreToolUse', rm)
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } })
    await reach(NeedsInput)
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        promptId: 'p1',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }
      }) + '\n'
    )
    await reach(Idle)
  })
})
