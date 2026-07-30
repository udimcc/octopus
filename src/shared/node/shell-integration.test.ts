import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveShellFamily,
  bashIntegrationScript,
  zshIntegrationScript,
  shellSpawnPlan,
  ensureShellIntegrationFiles
} from './shell-integration'

const FILES = { bashRcPath: '/data/octopus.bashrc', zshDotDir: '/data/zsh' }

describe('resolveShellFamily (§12.1)', () => {
  it('classifies bash and zsh by basename, everything else as other', () => {
    expect(resolveShellFamily('/bin/bash')).toBe('bash')
    expect(resolveShellFamily('/usr/local/bin/zsh')).toBe('zsh')
    expect(resolveShellFamily('/usr/bin/fish')).toBe('other')
    expect(resolveShellFamily('/bin/sh')).toBe('other')
  })
})

describe('integration scripts emit OSC 133 marks (§9.1)', () => {
  it('bash script sources the user rc and wires command-start/end + prompt marks', () => {
    const s = bashIntegrationScript()
    // Sources the user's own rc first — never edits it.
    expect(s).toContain('$OCTOPUS_USER_BASHRC')
    // The four semantic marks A/B/C/D ride the DEBUG trap / PROMPT_COMMAND / PS1.
    expect(s).toContain('133;C') // command-start
    expect(s).toContain('133;D') // command-end (with exit code)
    expect(s).toContain('133;A') // prompt-start
    expect(s).toContain('133;B') // prompt-end
    expect(s).toContain('trap')
    expect(s).toContain('PROMPT_COMMAND')
  })

  it('zsh script sources the user files, restores ZDOTDIR, and uses precmd/preexec', () => {
    const s = zshIntegrationScript()
    expect(s).toContain('OCTOPUS_USER_ZDOTDIR')
    expect(s).toContain('add-zsh-hook precmd')
    expect(s).toContain('add-zsh-hook preexec')
    expect(s).toContain('133;C')
    expect(s).toContain('133;D')
  })
})

describe('shellSpawnPlan (§12.1)', () => {
  it('launches bash interactively against the rcfile (login is incompatible)', () => {
    const plan = shellSpawnPlan('/bin/bash', FILES, { HOME: '/home/dev' })
    expect(plan.args).toEqual(['--rcfile', '/data/octopus.bashrc', '-i'])
    expect(plan.envPatch.OCTOPUS_USER_BASHRC).toBe('/home/dev/.bashrc')
  })

  it('omits OCTOPUS_USER_BASHRC when HOME is unknown', () => {
    const plan = shellSpawnPlan('/bin/bash', FILES, {})
    expect(plan.envPatch.OCTOPUS_USER_BASHRC).toBeUndefined()
  })

  it('redirects ZDOTDIR for zsh and remembers the prior value', () => {
    const plan = shellSpawnPlan('/bin/zsh', FILES, { ZDOTDIR: '/home/dev/.zsh' })
    expect(plan.args).toEqual(['-i'])
    expect(plan.envPatch.ZDOTDIR).toBe('/data/zsh')
    expect(plan.envPatch.OCTOPUS_USER_ZDOTDIR).toBe('/home/dev/.zsh')
  })

  it('does not set OCTOPUS_USER_ZDOTDIR when the user had none', () => {
    const plan = shellSpawnPlan('/bin/zsh', FILES, {})
    expect(plan.envPatch.ZDOTDIR).toBe('/data/zsh')
    expect(plan.envPatch.OCTOPUS_USER_ZDOTDIR).toBeUndefined()
  })

  it('falls back to a plain login shell (no injection) for any other shell', () => {
    const plan = shellSpawnPlan('/usr/bin/fish', FILES, { HOME: '/home/dev' })
    expect(plan.args).toEqual(['-l'])
    expect(plan.envPatch).toEqual({})
  })
})

describe('ensureShellIntegrationFiles', () => {
  it('writes the bash rc and a zsh ZDOTDIR/.zshrc under the dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopus-si-'))
    const files = ensureShellIntegrationFiles(dir)
    expect(files.bashRcPath).toBe(join(dir, 'octopus.bashrc'))
    expect(files.zshDotDir).toBe(join(dir, 'zsh'))
    expect(readFileSync(files.bashRcPath, 'utf8')).toContain('133;C')
    expect(readFileSync(join(files.zshDotDir, '.zshrc'), 'utf8')).toContain('add-zsh-hook')
  })

  it('is idempotent — re-running rewrites identical content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopus-si-'))
    ensureShellIntegrationFiles(dir)
    const first = readFileSync(join(dir, 'octopus.bashrc'), 'utf8')
    ensureShellIntegrationFiles(dir)
    expect(readFileSync(join(dir, 'octopus.bashrc'), 'utf8')).toBe(first)
  })
})
