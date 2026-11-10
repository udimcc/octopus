import { describe, it, expect } from 'vitest'
import {
  controlSocketPath,
  resolveControlSocketPath,
  resolveDataDir,
  MAX_UNIX_SOCKET_PATH_BYTES
} from './data-paths'

describe('data-paths', () => {
  it('resolves XDG_DATA_HOME when absolute, else ~/.local/share', () => {
    expect(resolveDataDir({ env: { XDG_DATA_HOME: '/x' }, platform: 'linux', home: '/h' })).toBe(
      '/x/octopus'
    )
    expect(resolveDataDir({ env: { XDG_DATA_HOME: 'rel' }, platform: 'linux', home: '/h' })).toBe(
      '/h/.local/share/octopus'
    )
    expect(resolveDataDir({ env: {}, platform: 'linux', home: '/h' })).toBe(
      '/h/.local/share/octopus'
    )
  })

  it('resolves %APPDATA% on win32 with backslashes', () => {
    expect(resolveDataDir({ env: { APPDATA: 'C:\\A' }, platform: 'win32', home: 'C:\\h' })).toBe(
      'C:\\A\\octopus'
    )
    expect(resolveDataDir({ env: {}, platform: 'win32', home: 'C:\\h' })).toBe(
      'C:\\h\\AppData\\Roaming\\octopus'
    )
  })

  it('places the control socket in the data dir, tolerating a trailing slash', () => {
    expect(controlSocketPath('/d/octopus')).toBe('/d/octopus/control.sock')
    expect(controlSocketPath('/d/octopus/')).toBe('/d/octopus/control.sock')
    expect(
      resolveControlSocketPath({ env: { XDG_DATA_HOME: '/x' }, platform: 'linux', home: '/h' })
    ).toBe('/x/octopus/control.sock')
  })

  it('exposes the sun_path limit', () => {
    expect(MAX_UNIX_SOCKET_PATH_BYTES).toBe(107)
  })
})
