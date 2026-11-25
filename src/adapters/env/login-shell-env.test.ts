import { describe, it, expect, vi } from 'vitest'
import {
  applyLoginShellEnv,
  LOGIN_ENV_SENTINEL as S,
  loginShellEnvPatch,
  loginShellProbeCommand,
  mergePathLists,
  parseLoginShellEnv,
  probeShell
} from './login-shell-env'

const probeOutput = (envLines: string[], noise = 'Welcome to zsh!\n'): string =>
  `${noise}\n${S}\n${envLines.join('\n')}\n\n${S}\nbye\n`

describe('parseLoginShellEnv', () => {
  it('reads PATH/LANG/LC_ALL between the sentinels, ignoring rc-file noise and other vars', () => {
    const out = probeOutput([
      'HOME=/Users/u',
      'PATH=/opt/homebrew/bin:/usr/bin:/bin',
      'LANG=en_US.UTF-8',
      'LC_ALL=',
      'FOO=PATH=/evil'
    ])
    expect(parseLoginShellEnv(out)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      LANG: 'en_US.UTF-8'
    })
  })

  it('ignores env-looking lines outside the sentinels', () => {
    const out = `PATH=/before\n${S}\nPATH=/inside\n${S}\nPATH=/after\n`
    expect(parseLoginShellEnv(out)).toEqual({ PATH: '/inside' })
  })

  it('returns undefined when either sentinel is missing', () => {
    expect(parseLoginShellEnv('PATH=/x\n')).toBeUndefined()
    expect(parseLoginShellEnv(`${S}\nPATH=/x\n`)).toBeUndefined()
  })

  it('the probe command prints the sentinel twice around /usr/bin/env', () => {
    const cmd = loginShellProbeCommand('SENT')
    expect(cmd.match(/SENT/g)).toHaveLength(2)
    expect(cmd).toContain('/usr/bin/env')
  })
})

describe('mergePathLists', () => {
  it('puts the first list first, then the rest, deduped, without empties', () => {
    expect(mergePathLists('/opt/homebrew/bin:/usr/bin:/bin', '/usr/bin:/bin:/usr/sbin:/sbin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    )
    expect(mergePathLists('/a::/a', undefined)).toBe('/a')
    expect(mergePathLists(undefined, '/b')).toBe('/b')
  })
})

describe('loginShellEnvPatch', () => {
  it('merges PATH and fills LANG/LC_ALL only when unset', () => {
    expect(
      loginShellEnvPatch(
        { PATH: '/usr/bin:/bin', LANG: 'he_IL.UTF-8' },
        { PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
      )
    ).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', LC_ALL: 'en_US.UTF-8' })
  })

  it('is empty when nothing changes', () => {
    expect(loginShellEnvPatch({ PATH: '/a:/b' }, { PATH: '/a' })).toEqual({})
  })
})

describe('probeShell', () => {
  it('prefers an absolute $SHELL, then the account shell, then /bin/zsh', () => {
    expect(probeShell('/bin/bash', '/bin/zsh')).toBe('/bin/bash')
    expect(probeShell(undefined, '/opt/homebrew/bin/fish')).toBe('/opt/homebrew/bin/fish')
    expect(probeShell('', 'zsh')).toBe('/bin/zsh')
  })
})

describe('applyLoginShellEnv', () => {
  it('is a no-op on linux and never runs a shell', () => {
    const run = vi.fn(() => '')
    const env = { PATH: '/usr/bin' }
    const r = applyLoginShellEnv({ platform: 'linux', env, run })
    expect(r.applied).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('on darwin runs `$SHELL -ilc <probe>` and merges into env in place', () => {
    const run = vi.fn(() => probeOutput(['PATH=/opt/homebrew/bin:/usr/bin', 'LANG=en_US.UTF-8']))
    const env: Record<string, string | undefined> = {
      SHELL: '/bin/zsh',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
    }
    const r = applyLoginShellEnv({ platform: 'darwin', env, run, accountShell: () => undefined })
    expect(run).toHaveBeenCalledWith('/bin/zsh', ['-ilc', loginShellProbeCommand()], 3000)
    expect(r).toMatchObject({ applied: true, keys: ['PATH', 'LANG'] })
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    expect(env.LANG).toBe('en_US.UTF-8')
  })

  it('falls back silently (env untouched) when the shell fails or prints nothing usable', () => {
    const env = { SHELL: '/bin/zsh', PATH: '/usr/bin' }
    const failing = applyLoginShellEnv({
      platform: 'darwin',
      env,
      run: () => {
        throw new Error('ETIMEDOUT')
      }
    })
    expect(failing.applied).toBe(false)
    expect(failing.message).toContain('ETIMEDOUT')
    const silent = applyLoginShellEnv({ platform: 'darwin', env, run: () => 'garbage' })
    expect(silent.applied).toBe(false)
    expect(env).toEqual({ SHELL: '/bin/zsh', PATH: '/usr/bin' })
  })
})
