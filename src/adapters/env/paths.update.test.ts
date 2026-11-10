import { describe, it, expect } from 'vitest'
import { resolveProgramDir, resolveUpdateStagingDir } from './paths'

describe('resolveProgramDir', () => {
  it('uses XDG_DATA_HOME when set', () => {
    expect(resolveProgramDir({ XDG_DATA_HOME: '/x/data' }, '/home/u')).toBe('/x/data/octopus-app')
  })

  it('falls back to ~/.local/share when unset or empty', () => {
    expect(resolveProgramDir({}, '/home/u')).toBe('/home/u/.local/share/octopus-app')
    expect(resolveProgramDir({ XDG_DATA_HOME: '' }, '/home/u')).toBe(
      '/home/u/.local/share/octopus-app'
    )
  })
})

describe('resolveUpdateStagingDir', () => {
  it('is a sibling of the program dir', () => {
    expect(resolveUpdateStagingDir({ XDG_DATA_HOME: '/x/data' }, '/home/u')).toBe(
      '/x/data/octopus-update-staging'
    )
    expect(resolveUpdateStagingDir({}, '/home/u')).toBe(
      '/home/u/.local/share/octopus-update-staging'
    )
  })
})
