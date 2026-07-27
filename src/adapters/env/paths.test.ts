import { describe, it, expect } from 'vitest'
import { resolveAppPaths, resolveWorktreeBase, resolveDefaultWorktreeBase } from './paths'

describe('resolveAppPaths', () => {
  it('honours XDG_DATA_HOME on Linux when set to an absolute path', () => {
    const paths = resolveAppPaths({
      env: { XDG_DATA_HOME: '/custom/data' },
      platform: 'linux',
      home: '/home/dev'
    })
    expect(paths.dataDir).toBe('/custom/data/octopus')
    expect(paths.dbPath).toBe('/custom/data/octopus/octopus.db')
    expect(paths.settingsPath).toBe('/custom/data/octopus/settings.json')
    expect(paths.logsDir).toBe('/custom/data/octopus/logs')
  })

  it('falls back to ~/.local/share on Linux when XDG_DATA_HOME is unset', () => {
    const paths = resolveAppPaths({ env: {}, platform: 'linux', home: '/home/dev' })
    expect(paths.dataDir).toBe('/home/dev/.local/share/octopus')
  })

  it('ignores a non-absolute XDG_DATA_HOME (per the XDG spec)', () => {
    const paths = resolveAppPaths({
      env: { XDG_DATA_HOME: 'relative/path' },
      platform: 'linux',
      home: '/home/dev'
    })
    expect(paths.dataDir).toBe('/home/dev/.local/share/octopus')
  })

  it('uses %APPDATA% on Windows when set', () => {
    const paths = resolveAppPaths({
      env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
      platform: 'win32',
      home: 'C:\\Users\\dev'
    })
    expect(paths.dataDir).toContain('octopus')
    expect(paths.dataDir).toContain('Roaming')
  })

  it('falls back to AppData/Roaming on Windows when APPDATA is unset', () => {
    const paths = resolveAppPaths({ env: {}, platform: 'win32', home: 'C:\\Users\\dev' })
    expect(paths.dataDir).toContain('Roaming')
    expect(paths.dataDir).toContain('octopus')
  })
})

describe('resolveWorktreeBase (§6.4)', () => {
  it('uses a configured absolute location verbatim', () => {
    expect(resolveWorktreeBase('/data/worktrees', '/home/dev')).toBe('/data/worktrees')
  })

  it('falls back to ~/octopus_repos when the location is empty', () => {
    expect(resolveWorktreeBase('', '/home/dev')).toBe('/home/dev/octopus_repos')
  })

  it('falls back to ~/octopus_repos when the location is undefined', () => {
    expect(resolveWorktreeBase(undefined, '/home/dev')).toBe('/home/dev/octopus_repos')
  })

  it('rejects a non-absolute (relative) location so worktrees never scatter under cwd', () => {
    expect(resolveWorktreeBase('relative/worktrees', '/home/dev')).toBe('/home/dev/octopus_repos')
  })

  it('resolveDefaultWorktreeBase mirrors the unset fallback for a given home', () => {
    expect(resolveDefaultWorktreeBase('/home/dev')).toBe('/home/dev/octopus_repos')
  })
})
