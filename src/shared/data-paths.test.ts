import { describe, it, expect } from 'vitest'
import { controlSocketPath, resolveControlSocketPath, resolveDataDir } from './data-paths'
import { osProfile } from './os'

describe('data-paths', () => {
  it('resolves XDG_DATA_HOME when absolute, else ~/.local/share', () => {
    expect(
      resolveDataDir({ env: { XDG_DATA_HOME: '/x' }, os: osProfile('linux'), home: '/h' })
    ).toBe('/x/octopus')
    expect(
      resolveDataDir({ env: { XDG_DATA_HOME: 'rel' }, os: osProfile('linux'), home: '/h' })
    ).toBe('/h/.local/share/octopus')
    expect(resolveDataDir({ env: {}, os: osProfile('linux'), home: '/h' })).toBe(
      '/h/.local/share/octopus'
    )
  })

  it('resolves %APPDATA% on win32 with backslashes', () => {
    expect(
      resolveDataDir({ env: { APPDATA: 'C:\\A' }, os: osProfile('win32'), home: 'C:\\h' })
    ).toBe('C:\\A\\octopus')
    expect(resolveDataDir({ env: {}, os: osProfile('win32'), home: 'C:\\h' })).toBe(
      'C:\\h\\AppData\\Roaming\\octopus'
    )
  })

  it('places the win32 control socket under %APPDATA% with backslashes', () => {
    expect(
      resolveControlSocketPath({ env: { APPDATA: 'C:\\A' }, os: osProfile('win32'), home: 'C:\\h' })
    ).toBe('C:\\A\\octopus\\control.sock')
  })

  it('places the control socket in the data dir, tolerating a trailing slash', () => {
    expect(controlSocketPath('/d/octopus', osProfile('linux'))).toBe('/d/octopus/control.sock')
    expect(controlSocketPath('/d/octopus/', osProfile('linux'))).toBe('/d/octopus/control.sock')
    expect(
      resolveControlSocketPath({ env: { XDG_DATA_HOME: '/x' }, os: osProfile('linux'), home: '/h' })
    ).toBe('/x/octopus/control.sock')
  })

  it('exposes the sun_path limit', () => {
    expect(osProfile('linux').paths.maxUnixSocketPathBytes).toBe(107)
    expect(osProfile('darwin').paths.maxUnixSocketPathBytes).toBe(103)
  })

  // Deliberate: NOT ~/Library/Application Support (case-insensitive collision with
  // Electron's `.../Octopus` userData, short darwin sun_path, CLI/app agreement).
  it('keeps the XDG data dir on darwin', () => {
    expect(resolveDataDir({ env: {}, os: osProfile('darwin'), home: '/Users/u' })).toBe(
      '/Users/u/.local/share/octopus'
    )
    expect(
      resolveDataDir({ env: { XDG_DATA_HOME: '/x' }, os: osProfile('darwin'), home: '/h' })
    ).toBe('/x/octopus')
    expect(resolveControlSocketPath({ env: {}, os: osProfile('darwin'), home: '/Users/u' })).toBe(
      '/Users/u/.local/share/octopus/control.sock'
    )
  })
})
