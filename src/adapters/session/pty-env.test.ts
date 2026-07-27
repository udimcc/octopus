import { describe, it, expect } from 'vitest'
import { buildPtyEnv, resolveShell } from './pty-env'
import { asTaskId, asSessionId } from '../../domain/ids'

const ctx = {
  taskId: asTaskId('t1'),
  sessionId: asSessionId('s1'),
  worktreePath: '/wt/t1'
}

describe('buildPtyEnv (§6.1)', () => {
  it('strips multiplexer/terminal identity vars (TMUX, TMUX_PANE, STY, WINDOWID)', () => {
    const env = buildPtyEnv(
      {
        PATH: '/usr/bin',
        TMUX: '/tmp/tmux-1000/default,123,0',
        TMUX_PANE: '%3',
        STY: '4242.pts-0.host',
        WINDOWID: '58720258'
      },
      ctx
    )
    expect(env.TMUX).toBeUndefined()
    expect(env.TMUX_PANE).toBeUndefined()
    expect(env.STY).toBeUndefined()
    expect(env.WINDOWID).toBeUndefined()
    // Non-stripped vars are preserved.
    expect(env.PATH).toBe('/usr/bin')
  })

  it('sets TERM, COLORTERM and the OCTOPUS_* identity vars', () => {
    const env = buildPtyEnv({ PATH: '/bin' }, ctx)
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.OCTOPUS_TASK_ID).toBe('t1')
    expect(env.OCTOPUS_SESSION_ID).toBe('s1')
    expect(env.OCTOPUS_WORKTREE).toBe('/wt/t1')
  })

  it('exports OCTOPUS_STATE_SOCKET only when a socket path is given (§9.2 seam)', () => {
    expect(buildPtyEnv({}, ctx).OCTOPUS_STATE_SOCKET).toBeUndefined()
    const withSock = buildPtyEnv({}, { ...ctx, stateSocketPath: '/tmp/octopus-1000/session-s1.sock' })
    expect(withSock.OCTOPUS_STATE_SOCKET).toBe('/tmp/octopus-1000/session-s1.sock')
  })

  it('drops undefined inherited values (never stringifies to "undefined")', () => {
    const env = buildPtyEnv({ FOO: undefined, BAR: 'ok' }, ctx)
    expect('FOO' in env).toBe(false)
    expect(env.BAR).toBe('ok')
  })

  it('lets OCTOPUS_* / TERM override any inherited value of the same name', () => {
    const env = buildPtyEnv({ TERM: 'dumb', OCTOPUS_TASK_ID: 'stale' }, ctx)
    expect(env.TERM).toBe('xterm-256color')
    expect(env.OCTOPUS_TASK_ID).toBe('t1')
  })
})

describe('resolveShell (§6.1)', () => {
  it('prefers the explicit override', () => {
    expect(resolveShell('/bin/zsh', '/bin/fish', '/bin/dash')).toBe('/bin/zsh')
  })
  it('falls back to the setting, then $SHELL, then /bin/bash', () => {
    expect(resolveShell(undefined, '/bin/fish', '/bin/dash')).toBe('/bin/fish')
    expect(resolveShell(undefined, undefined, '/bin/dash')).toBe('/bin/dash')
    expect(resolveShell(undefined, undefined, undefined)).toBe('/bin/bash')
  })
  it('treats empty strings as unset (a blank setting never yields "")', () => {
    expect(resolveShell('', '', '')).toBe('/bin/bash')
    expect(resolveShell('', '/bin/fish', '')).toBe('/bin/fish')
  })
})
