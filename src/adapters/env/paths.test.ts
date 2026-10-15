import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAppPaths,
  resolveWorktreeBase,
  resolveDefaultWorktreeBase,
  ensureAppDirs
} from './paths'

// Keep `node:fs` real by default; individual tests override `chmodSync` with
// `vi.mocked(chmodSync).mockImplementation(...)` where needed, then restore it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) }
})

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
    expect(paths.stateLogPath).toBe('/custom/data/octopus/logs/state.log')
    expect(paths.shellIntegrationDir).toBe('/custom/data/octopus/shell-integration')
    expect(paths.claudeStateDir).toBe('/custom/data/octopus/claude-state')
    expect(paths.credentialsDir).toBe('/custom/data/octopus/credentials')
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

describe('ensureAppDirs', () => {
  it('creates the data, logs, and claude-state dirs (idempotently)', () => {
    const base = mkdtempSync(join(tmpdir(), 'octopus-paths-'))
    try {
      const paths = resolveAppPaths({
        env: { XDG_DATA_HOME: base },
        platform: 'linux',
        home: '/home/dev'
      })
      ensureAppDirs(paths)
      // A second call must not throw (recursive mkdir is idempotent).
      ensureAppDirs(paths)
      expect(existsSync(paths.dataDir)).toBe(true)
      expect(existsSync(paths.logsDir)).toBe(true)
      expect(existsSync(paths.claudeStateDir)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('creates credentialsDir with mode 0700 (encrypted secrets, never readable by others)', () => {
    const base = mkdtempSync(join(tmpdir(), 'octopus-paths-'))
    try {
      const paths = resolveAppPaths({
        env: { XDG_DATA_HOME: base },
        platform: 'linux',
        home: '/home/dev'
      })
      ensureAppDirs(paths)
      expect(existsSync(paths.credentialsDir)).toBe(true)
      expect(statSync(paths.credentialsDir).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('does not throw when chmod on credentialsDir fails (best-effort, EPERM/non-POSIX fs)', () => {
    const base = mkdtempSync(join(tmpdir(), 'octopus-paths-'))
    try {
      const paths = resolveAppPaths({
        env: { XDG_DATA_HOME: base },
        platform: 'linux',
        home: '/home/dev'
      })
      vi.mocked(chmodSync).mockImplementationOnce(() => {
        throw new Error('EPERM: simulated chmod failure')
      })
      expect(() => ensureAppDirs(paths)).not.toThrow()
      // The dir was still created (mkdirSync ran before the failing chmod).
      expect(existsSync(paths.credentialsDir)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
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
