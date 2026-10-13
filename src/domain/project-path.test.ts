import { describe, it, expect } from 'vitest'
import { canonProjectPath } from './project-path'

describe('canonProjectPath (§6.3/§6.4)', () => {
  it('leaves an already-canonical absolute path unchanged', () => {
    expect(canonProjectPath('/repo/main')).toBe('/repo/main')
  })

  it('strips a single trailing slash', () => {
    expect(canonProjectPath('/repo/main/')).toBe('/repo/main')
  })

  it('does not strip the trailing slash off the root path itself', () => {
    expect(canonProjectPath('/')).toBe('/')
  })

  it('collapses repeated slashes', () => {
    expect(canonProjectPath('/repo//main///x')).toBe('/repo/main/x')
  })

  it('trims surrounding whitespace', () => {
    expect(canonProjectPath('  /repo/main  ')).toBe('/repo/main')
  })

  it('reduces an empty string to empty', () => {
    expect(canonProjectPath('')).toBe('')
  })

  it('reduces a whitespace-only string to empty', () => {
    expect(canonProjectPath('   ')).toBe('')
  })

  it('agrees for two spellings of the same path (the point of the helper)', () => {
    expect(canonProjectPath('/repo/main/')).toBe(canonProjectPath('/repo/main'))
    expect(canonProjectPath('  /repo//main  ')).toBe(canonProjectPath('/repo/main'))
  })
})
