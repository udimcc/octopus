import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAppDirs, resolveAppPaths } from '../../src/adapters/env/paths'

describe('ensureAppDirs (integration)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'octopus-test-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates the data and logs directories under a temp XDG_DATA_HOME', () => {
    const dataHome = join(tmpHome, 'xdg-data')
    const paths = resolveAppPaths({
      env: { XDG_DATA_HOME: dataHome },
      platform: 'linux',
      home: tmpHome
    })

    // Neither exists before.
    expect(existsSync(paths.dataDir)).toBe(false)

    const returned = ensureAppDirs(paths)

    expect(returned).toEqual(paths)
    expect(statSync(paths.dataDir).isDirectory()).toBe(true)
    expect(statSync(paths.logsDir).isDirectory()).toBe(true)
  })

  it('is idempotent (a second call does not throw)', () => {
    const paths = resolveAppPaths({
      env: { XDG_DATA_HOME: join(tmpHome, 'xdg-data') },
      platform: 'linux',
      home: tmpHome
    })
    ensureAppDirs(paths)
    expect(() => ensureAppDirs(paths)).not.toThrow()
  })
})
