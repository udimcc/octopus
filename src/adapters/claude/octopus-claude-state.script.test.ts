/**
 * Exercises the REAL python3 hook recorder (not a TS mirror) by writing it to a temp
 * dir and shelling out — so the script that actually ships is what's tested, inside
 * the normal `npm run test` run. Skips gracefully if python3 is unavailable (it is
 * present on the target host at /usr/bin/python3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureClaudeStateScript,
  CLAUDE_STATE_DIR_NAME,
  ORIGINAL_STATUSLINE_FILE,
  EVENTS_FILE_SUFFIX
} from './octopus-claude-state.script'

const PYTHON = '/usr/bin/python3'
const hasPython = ((): boolean => {
  try {
    return spawnSync(PYTHON, ['--version']).status === 0
  } catch {
    return false
  }
})()

const FIXTURES = join(__dirname, '../../../test/fixtures/claude-state')

describe.skipIf(!hasPython)('octopus-claude-state.py', () => {
  let dir: string
  let scriptPath: string
  let stateDir: string
  const SID = 'sess-1'
  const env = { OCTOPUS_SESSION_ID: SID }

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
  function run(args: string[], input: string, extraEnv: Record<string, string> = {}): string {
    return execFileSync(PYTHON, [scriptPath, ...args], {
      input,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extraEnv },
      encoding: 'utf8'
    })
  }

  const hook = (event: string, payload: unknown, extraEnv = env): string =>
    run(['hook', event], typeof payload === 'string' ? payload : JSON.stringify(payload), extraEnv)

  function records(sid = SID): Array<Record<string, unknown>> {
    const path = join(stateDir, sid + EVENTS_FILE_SUFFIX)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  it('ensureClaudeStateScript writes the script and the claude-state dir', () => {
    expect(existsSync(scriptPath)).toBe(true)
    expect(existsSync(stateDir)).toBe(true)
  })

  it('records the live trace exactly as the golden fixture (modulo timestamps)', () => {
    const hooks = readFileSync(join(FIXTURES, 'trace-2bg-perm.hooks.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { ev: string; p: unknown })
    const before = Date.now()
    for (const h of hooks) hook(h.ev, h.p)
    const golden = readFileSync(join(FIXTURES, 'trace-2bg-perm.events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const got = records()
    expect(got.every((r) => typeof r.t === 'number' && (r.t as number) >= before - 1000)).toBe(true)
    const strip = (r: Record<string, unknown>): Record<string, unknown> => ({ ...r, t: 0 })
    expect(got.map(strip)).toEqual(golden.map(strip))
  })

  it('never prints on the hook path and exits 0 even on garbage input', () => {
    expect(hook('Stop', 'not json')).toBe('')
    expect(hook('PreToolUse', '[1,2]')).toBe('')
    expect(records().map((r) => r.ev)).toEqual(['Stop', 'PreToolUse'])
  })

  it('records nothing when OCTOPUS_SESSION_ID is unset or not a safe file stem', () => {
    hook('Stop', {}, {} as typeof env)
    hook('Stop', {}, { OCTOPUS_SESSION_ID: '../escape' })
    hook('Stop', {}, { OCTOPUS_SESSION_ID: '' })
    expect(readdirSync(stateDir)).toEqual([])
    expect(existsSync(join(dir, 'escape' + EVENTS_FILE_SUFFIX))).toBe(false)
  })

  it('records nothing for a malformed event name', () => {
    hook('Stop; rm -rf', {})
    hook('', {})
    expect(records()).toEqual([])
  })

  it('stores a task-notification id, never the prompt text', () => {
    hook('UserPromptSubmit', { prompt: 'secret human prompt', prompt_id: 'p1' })
    hook('UserPromptSubmit', {
      prompt: '<task-notification>\n<task-id>abc123</task-id>\n<result>x</result>',
      prompt_id: 'p2'
    })
    const [human, wake] = records()
    expect(human).not.toHaveProperty('tn')
    expect(JSON.stringify(human)).not.toContain('secret')
    expect(wake.tn).toBe('abc123')
  })

  it('hashes tool_input canonically so a PermissionRequest matches its PreToolUse', () => {
    hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { a: 1, b: 'x' } })
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { b: 'x', a: 1 } })
    hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu2', tool_input: { a: 2 } })
    const [pre, perm, other] = records()
    expect(perm.ih).toBe(pre.ih)
    expect(other.ih).not.toBe(pre.ih)
    expect(perm).not.toHaveProperty('tu')
  })

  it('tags background vs foreground Agent completions and interrupts', () => {
    hook('PostToolUse', {
      tool_name: 'Agent',
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'bgA' }
    })
    hook('PostToolUse', {
      tool_name: 'Task',
      tool_response: { agentId: 'fgB', status: 'completed' }
    })
    hook('PostToolUse', { tool_name: 'Bash', tool_response: { agentId: 'nope' } })
    hook('PostToolUseFailure', { tool_name: 'Bash', is_interrupt: true })
    const [bg, fg, bash, fail] = records()
    expect(bg.bga).toBe('bgA')
    expect(fg.fga).toBe('fgB')
    expect(bash).not.toHaveProperty('bga')
    expect(bash).not.toHaveProperty('fga')
    expect(fail.intr).toBe(true)
  })

  it('caps the background_tasks inventory and its strings', () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({
      id: `id${i}`.padEnd(100, 'x'),
      type: 'subagent',
      status: 'running',
      description: 'd'.repeat(500)
    }))
    hook('Stop', { background_tasks: tasks })
    const [stop] = records()
    const bg = stop.bg as Array<Record<string, unknown>>
    expect(bg).toHaveLength(32)
    expect((bg[0].id as string).length).toBe(64)
    expect(bg[0]).not.toHaveProperty('description')
  })

  it('N parallel hooks append N whole lines (O_APPEND, no lock)', async () => {
    const runAsync = (input: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(PYTHON, [scriptPath, 'hook', 'PreToolUse'], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }
        })
        child.on('error', reject)
        child.on('close', () => resolve())
        child.stdin.end(input)
      })
    const N = 30
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runAsync(
          JSON.stringify({ tool_name: 'Bash', tool_use_id: `tu${i}`, agent_id: `a${i % 3}` })
        )
      )
    )
    const got = records()
    expect(got).toHaveLength(N)
    expect(new Set(got.map((r) => r.tu)).size).toBe(N)
  })

  describe('nested claude detection', () => {
    // A stand-in `claude` executable: a shell script's process comm is its file name.
    // It runs its argv as a child (never exec), so it stays in the ancestry.
    let fakeClaude: string
    beforeEach(() => {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      fakeClaude = join(bin, 'claude')
      writeFileSync(fakeClaude, '#!/bin/sh\n"$@"\nstatus=$?\nexit $status\n', 'utf8')
      chmodSync(fakeClaude, 0o755)
    })

    const viaClaude = (outerEnv: Record<string, string>, nested: boolean): void => {
      const argv = [PYTHON, scriptPath, 'hook', 'Stop']
      const cmd = nested ? [fakeClaude, fakeClaude, ...argv] : [fakeClaude, ...argv]
      execFileSync(cmd[0], cmd.slice(1), {
        input: '{}',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...outerEnv }
      })
    }

    it('records a hook whose claude is the session’s own', () => {
      viaClaude(env, false)
      expect(records()).toHaveLength(1)
    })

    it('drops a hook of a claude started from inside the session’s claude', () => {
      viaClaude(env, true)
      expect(records()).toHaveLength(0)
    })
  })

  it('statusline delegates to the saved original command and echoes its stdout', () => {
    writeFileSync(join(stateDir, ORIGINAL_STATUSLINE_FILE), 'printf ORIGINAL_BAR', 'utf8')
    const out = run(['statusline'], JSON.stringify({ session_id: SID, transcript_path: '' }), env)
    expect(out).toContain('ORIGINAL_BAR')
    expect(readdirSync(stateDir)).toEqual([ORIGINAL_STATUSLINE_FILE]) // records nothing
  })

  it('statusline passes its stdin to the original command', () => {
    writeFileSync(join(stateDir, ORIGINAL_STATUSLINE_FILE), 'cat', 'utf8')
    expect(run(['statusline'], '{"model":"m"}', {})).toBe('{"model":"m"}')
  })

  it('statusline prints nothing without a saved original command', () => {
    expect(run(['statusline'], '{}', env)).toBe('')
  })

  it('any other mode is a silent no-op', () => {
    expect(run(['get', SID], '', env)).toBe('')
    expect(run([], '', env)).toBe('')
    expect(readdirSync(stateDir)).toEqual([])
  })
})
