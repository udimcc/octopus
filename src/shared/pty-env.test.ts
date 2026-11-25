import { describe, it, expect } from 'vitest'
import { buildPtyEnv, resolveShell, sessionScopedEnv } from './pty-env'
import { osProfile } from './os'

const linux = osProfile('linux')
const darwin = osProfile('darwin')

const ctx = {
  taskId: 't1',
  sessionId: 's1',
  worktreePath: '/wt/t1',
  os: linux
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

  it('drops undefined inherited values (never stringifies to "undefined")', () => {
    const env = buildPtyEnv({ FOO: undefined, BAR: 'ok' }, ctx)
    expect('FOO' in env).toBe(false)
    expect(env.BAR).toBe('ok')
  })

  it('sets OCTOPUS_CONTROL_SOCKET only when a control socket path is given', () => {
    const withSock = buildPtyEnv({}, { ...ctx, controlSocketPath: '/d/octopus/control.sock' })
    expect(withSock.OCTOPUS_CONTROL_SOCKET).toBe('/d/octopus/control.sock')
    expect('OCTOPUS_CONTROL_SOCKET' in buildPtyEnv({}, ctx)).toBe(false)
    expect('OCTOPUS_CONTROL_SOCKET' in buildPtyEnv({}, { ...ctx, controlSocketPath: '' })).toBe(
      false
    )
  })

  it('lets OCTOPUS_CONTROL_SOCKET from the app override an inherited stale value', () => {
    const env = buildPtyEnv(
      { OCTOPUS_CONTROL_SOCKET: '/stale.sock' },
      { ...ctx, controlSocketPath: '/new.sock' }
    )
    expect(env.OCTOPUS_CONTROL_SOCKET).toBe('/new.sock')
  })

  it('lets OCTOPUS_* / TERM override any inherited value of the same name', () => {
    const env = buildPtyEnv({ TERM: 'dumb', OCTOPUS_TASK_ID: 'stale' }, ctx)
    expect(env.TERM).toBe('xterm-256color')
    expect(env.OCTOPUS_TASK_ID).toBe('t1')
  })

  it('defaults LANG to en_US.UTF-8 on darwin when no locale var is inherited', () => {
    expect(buildPtyEnv({ PATH: '/bin' }, { ...ctx, os: darwin }).LANG).toBe('en_US.UTF-8')
    expect(buildPtyEnv({ LANG: '' }, { ...ctx, os: darwin }).LANG).toBe('en_US.UTF-8')
  })

  it('keeps a user-chosen locale on darwin (LANG, LC_ALL or LC_CTYPE)', () => {
    const d = { ...ctx, os: darwin }
    expect(buildPtyEnv({ LANG: 'he_IL.UTF-8' }, d).LANG).toBe('he_IL.UTF-8')
    expect(buildPtyEnv({ LC_ALL: 'C' }, d).LANG).toBeUndefined()
    expect(buildPtyEnv({ LC_CTYPE: 'UTF-8' }, d).LANG).toBeUndefined()
  })

  it('never invents a LANG on linux (or win32)', () => {
    expect('LANG' in buildPtyEnv({}, ctx)).toBe(false)
    expect('LANG' in buildPtyEnv({}, { ...ctx, os: osProfile('win32') })).toBe(false)
  })
})

describe('resolveShell (§6.1)', () => {
  it('prefers the explicit override', () => {
    expect(resolveShell('/bin/zsh', '/bin/fish', '/bin/dash', linux)).toBe('/bin/zsh')
  })
  it('falls back to the setting, then $SHELL, then /bin/bash', () => {
    expect(resolveShell(undefined, '/bin/fish', '/bin/dash', linux)).toBe('/bin/fish')
    expect(resolveShell(undefined, undefined, '/bin/dash', linux)).toBe('/bin/dash')
    expect(resolveShell(undefined, undefined, undefined, linux)).toBe('/bin/bash')
  })
  it('treats empty strings as unset (a blank setting never yields "")', () => {
    expect(resolveShell('', '', '', linux)).toBe('/bin/bash')
    expect(resolveShell('', '/bin/fish', '', linux)).toBe('/bin/fish')
  })
  it('falls back to /bin/zsh on darwin, /bin/bash elsewhere', () => {
    expect(resolveShell(undefined, undefined, undefined, darwin)).toBe('/bin/zsh')
    expect(resolveShell('', '', '', darwin)).toBe('/bin/zsh')
    expect(resolveShell(undefined, undefined, undefined, linux)).toBe('/bin/bash')
    expect(resolveShell(undefined, undefined, '/bin/bash', darwin)).toBe('/bin/bash')
  })
})

/**
 * REGRESSION: `octopusd` outlives a logout, so the env it forks children from can name a
 * dead login session — `emacsclient -c`, `xdg-open` and agent-based pushes then fail in a
 * shell that otherwise looks fine. The app is launched from the LIVE session, so its
 * values are forwarded as a spawn env patch.
 */
describe("sessionScopedEnv (§6.1/§6.2 — a long-lived daemon's stale login session)", () => {
  it('picks out the display/auth/bus/agent vars and nothing else', () => {
    expect(
      sessionScopedEnv({
        PATH: '/usr/bin',
        HOME: '/home/u',
        LANG: 'en_US.UTF-8',
        DISPLAY: ':104',
        XAUTHORITY: '/run/user/1000/gdm/Xauthority',
        XDG_SESSION_ID: '1185',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh'
      })
    ).toEqual({
      DISPLAY: ':104',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
      XDG_SESSION_ID: '1185',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh'
    })
  })

  it('omits absent and empty vars — a missing one means "no opinion", not "unset it"', () => {
    expect(sessionScopedEnv({ DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' })).toEqual({
      WAYLAND_DISPLAY: 'wayland-0'
    })
    expect(sessionScopedEnv({})).toEqual({})
  })
})
