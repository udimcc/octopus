import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSafetyCanonicalizer } from './fs-path-probe'

describe('deleteSafetyCanonicalizer (§6.4)', () => {
  it('is absent off macOS, so Linux keeps plain string compares', () => {
    expect(deleteSafetyCanonicalizer('linux')).toBeUndefined()
    expect(deleteSafetyCanonicalizer('win32')).toBeUndefined()
  })

  describe('darwin mapping (real fs)', () => {
    let root: string
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-canon-')))
      mkdirSync(join(root, 'Repo'))
      symlinkSync(join(root, 'Repo'), join(root, 'link'))
    })
    afterAll(() => rmSync(root, { recursive: true, force: true }))
    const canon = deleteSafetyCanonicalizer('darwin')!

    it('resolves symlinks and case-folds', () => {
      expect(canon(join(root, 'link'))).toBe(join(root, 'Repo').toLowerCase())
      expect(canon(join(root, 'Repo'))).toBe(join(root, 'repo').toLowerCase())
    })

    it('resolves the deepest existing ancestor of a path that is already gone', () => {
      expect(canon(join(root, 'link', 'gone', 'deeper'))).toBe(
        join(root, 'Repo', 'gone', 'deeper').toLowerCase()
      )
    })
  })
})
