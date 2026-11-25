import { describe, it, expect } from 'vitest'
import { PROFILES } from '../../os'
import { hostOs, hostProfile } from './host'

describe('host OS', () => {
  it('hostOs is a known OsId and hostProfile is its profile', () => {
    expect(Object.keys(PROFILES)).toContain(hostOs())
    expect(hostProfile()).toBe(PROFILES[hostOs()])
  })
})
