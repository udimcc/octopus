/**
 * The documented way to start Claude with a prompt (`resources/claude-skill/octopus/SKILL.md`):
 * write the prompt to a temp file with a quoted heredoc, then pass
 * `--command "claude -- \"\$(cat '$F'; rm -f '$F')\""` to `octopus-cli session open`. Here that exact
 * recipe is run in bash, the resulting argument goes through the REAL CLI arg parser and the REAL
 * `createControlHandlers` (only the command loop is replaced by a capture of the dispatched
 * command), and the `launchCommand` is typed into a REAL POSIX shell with a stub `claude` on PATH
 * that records its argv. Proves a prompt with quotes, newlines, `$()`, backticks and a leading `-`
 * reaches claude as exactly one argument after `--`, byte for byte, and the temp file is gone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlHandlers } from '../../src/main/control-handlers'
import { parseCommand } from '../../src/cli/args'
import { CONTROL_PROTOCOL_VERSION, MAX_COMMAND_BYTES } from '../../src/shared/control-protocol'
import type { Command } from '../../src/application/commands'
import type { TaskSnapshot } from '../../src/domain/snapshots'
import { TaskLifecycle } from '../../src/domain/lifecycle'
import { TaskState } from '../../src/domain/state'
import { asTaskId } from '../../src/domain/ids'

// zsh is exercised when installed (skipped otherwise).
const shells = ['bash', 'sh', 'zsh'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0)
const hasBash = shells.includes('bash')

// Per-run canary: a successful injection (`touch <canary>`) would create it.
const canaryDir = mkdtempSync(join(tmpdir(), 'octopus-canary-'))
const canary = join(canaryDir, 'pwned')

let root: string
let tmpDir: string
let binDir: string
let argvOut: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "octopus launch's "))
  // A space in TMPDIR proves the recipe quotes $F.
  tmpDir = mkdtempSync(join(tmpdir(), 'octopus skill '))
  binDir = join(root, 'bin')
  argvOut = join(root, 'argv.bin')
  mkdirSync(binDir)
  const stub = join(binDir, 'claude')
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\0' "$@" > "$ARGV_OUT"\n`)
  chmodSync(stub, 0o755)
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(canaryDir, { recursive: true, force: true })
  rmSync(tmpDir, { recursive: true, force: true })
})

/** The SKILL.md recipe, verbatim, run in bash: yields the `--command` argument for `prompt`. */
function skillCommandArg(prompt: string): string {
  const script = [
    'F=$(mktemp)',
    'cat > "$F" <<\'EOF\'',
    prompt,
    'EOF',
    `printf %s "claude -- \\"\\$(cat '$F'; rm -f '$F')\\""`
  ].join('\n')
  const res = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    env: { ...process.env, TMPDIR: tmpDir },
    encoding: 'utf8'
  })
  expect(res.status).toBe(0)
  return res.stdout
}

/** CLI parser -> production handler: the `launchCommand` that gets typed into the shell. */
async function launchLineFor(prompt: string): Promise<string> {
  const parsed = parseCommand(['session', 'open', 't1', '--command', skillCommandArg(prompt)])
  expect(parsed.kind).toBe('call')
  const params = (parsed as { params: Record<string, unknown> }).params
  const task: TaskSnapshot = {
    id: asTaskId('t1'),
    name: 't1',
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions: [],
    position: 0,
    createdAt: 1
  }
  let dispatched: Command | undefined
  const handle = createControlHandlers({
    dispatch: async (c) => {
      dispatched = c
      return { ok: true, sessionId: 's1' as never }
    },
    listProjects: () => [],
    getSnapshot: () => ({ tasks: [task] })
  })
  const reply = await handle({
    id: 'r',
    version: CONTROL_PROTOCOL_VERSION,
    method: 'session.open',
    params
  })
  expect(reply.ok).toBe(true)
  const input = (dispatched as { input: { launchCommand?: string; background?: boolean } }).input
  expect(input.background).toBe(true)
  expect(input.launchCommand).toBeDefined()
  return input.launchCommand as string
}

/** Type `line` into a fresh shell (stdin, like a PTY) with the stub `claude` first on PATH. */
function runInShell(shell: string, line: string): { status: number | null; argv: string[] } {
  rmSync(argvOut, { force: true })
  const res = spawnSync(
    shell,
    shell === 'bash' ? ['--noprofile', '--norc'] : shell === 'zsh' ? ['-f'] : [],
    {
      input: line + '\n',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ARGV_OUT: argvOut },
      encoding: 'utf8'
    }
  )
  const raw = existsSync(argvOut) ? readFileSync(argvOut, 'utf8') : ''
  const argv = raw === '' ? [] : raw.split('\0').slice(0, -1)
  return { status: res.status, argv }
}

const PROMPTS: Array<[string, string]> = [
  ['plain', 'fix the bug in foo.ts'],
  ['single and double quotes', `it's a "quoted" 'string' and \\"escaped\\"`],
  ['newlines', 'line1\nline2\n\nline4'],
  ['command substitution', `run $(touch ${canary}) now`],
  ['backticks', `run \`touch ${canary}\` now`],
  ['variables and globs', '$HOME ${PATH} * ? [a-z] ~ !! \\n \\\\'],
  ['leading dash', '- a markdown bullet'],
  ['leading double dash', '--- front matter\ntitle: x'],
  ['looks like a flag', '--dangerously-skip-permissions'],
  ['semicolons and pipes', 'a; b && c || d | e > f < g &'],
  ['non-ascii', 'héllo 中文 \u{1F419}'],
  ['everything', `- it's "all" $(id) \`id\` \\ ; \n  * 'x'`]
]

describe.skipIf(!hasBash)('launch command in a real shell', () => {
  for (const shell of shells) {
    describe(shell, () => {
      it.each(PROMPTS)(
        'delivers a prompt with %s verbatim as ONE argument after --',
        async (_n, prompt) => {
          const line = await launchLineFor(prompt)
          const { status, argv } = runInShell(shell, line)
          expect(status).toBe(0)
          expect(argv).toEqual(['--', prompt])
          // One-shot: the temp file has been removed by the line itself.
          expect(readdirSync(tmpDir)).toEqual([])
          expect(existsSync(canary)).toBe(false)
        }
      )
    })
  }

  it('the typed line is a single line well under the command limit', async () => {
    const line = await launchLineFor('SECRET-PROMPT-TEXT $(id)\nsecond line')
    expect(line).not.toContain('SECRET-PROMPT-TEXT') // the prompt rides in the file only
    expect(line).not.toMatch(/[\r\n\0]/)
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_COMMAND_BYTES)
    expect(line.startsWith(`claude -- "$(cat '`)).toBe(true)
  })

  it('$(cat) strips trailing newlines (pinned behaviour; interior newlines are kept)', async () => {
    const { argv } = runInShell('bash', await launchLineFor('body\n\n'))
    expect(argv).toEqual(['--', 'body'])
  })

  it('still runs claude with an empty argument if the temp file vanished first', async () => {
    const line = await launchLineFor('x')
    // Delete the file before the line runs: `cat` fails, claude gets "".
    for (const f of readdirSync(tmpDir)) rmSync(join(tmpDir, f))
    const { argv } = runInShell('bash', line)
    expect(argv).toEqual(['--', ''])
  })
})
