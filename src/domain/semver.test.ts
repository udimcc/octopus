import { describe, it, expect } from 'vitest'
import { parseSemver, compareSemver, isNewer, parseReleaseDirName } from './semver'

describe('parseSemver', () => {
  it('parses X.Y.Z', () => {
    expect(parseSemver('1.10.3')).toEqual({ major: 1, minor: 10, patch: 3 })
    expect(parseSemver('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 })
  })

  it.each([
    '',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '1.2.3-rc1',
    '1.2.3+b',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    ' 1.2.3',
    '1.2.x'
  ])('rejects %j', (s) => {
    expect(parseSemver(s)).toBeNull()
  })

  it('rejects unsafe integer components', () => {
    expect(parseSemver('99999999999999999999.0.0')).toBeNull()
  })
})

describe('compareSemver / isNewer', () => {
  it('orders numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
    expect(isNewer('1.9.0', '1.10.0')).toBe(false)
  })

  it('equal and older are not newer', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
    expect(isNewer('1.2.2', '1.2.3')).toBe(false)
    expect(isNewer('0.9.9', '1.0.0')).toBe(false)
  })

  it('patch and major bumps are newer', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true)
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
  })

  it('malformed on either side is never newer', () => {
    expect(isNewer('', '1.0.0')).toBe(false)
    expect(isNewer('1.0.1', '')).toBe(false)
    expect(isNewer('1.0.1-rc1', '1.0.0')).toBe(false)
  })

  it('compareSemver sign', () => {
    const a = { major: 1, minor: 0, patch: 0 }
    const b = { major: 1, minor: 0, patch: 1 }
    expect(compareSemver(a, b)).toBeLessThan(0)
    expect(compareSemver(b, a)).toBeGreaterThan(0)
    expect(compareSemver(a, a)).toBe(0)
  })
})

describe('parseReleaseDirName', () => {
  it('parses octopus-X.Y.Z', () => {
    expect(parseReleaseDirName('octopus-1.2.0')).toEqual({ major: 1, minor: 2, patch: 0 })
  })

  it.each([
    'octopus-1.2',
    'octopus-v1.2.0',
    'octopus-1.2.0-rc1',
    'foo-1.2.0',
    '',
    'octopus-',
    '1.2.0',
    '.incoming'
  ])('rejects %j', (s) => {
    expect(parseReleaseDirName(s)).toBeNull()
  })
})
