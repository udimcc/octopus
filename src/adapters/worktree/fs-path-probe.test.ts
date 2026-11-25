import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSafetyCanonicalizer } from './fs-path-probe'
import { osProfile } from '../../shared/os'

describe('deleteSafetyCanonicalizer (§6.4)', () => {
  it("is absent for 'exact' (Linux, win32), so they keep plain string compares", () => {
    expect(deleteSafetyCanonicalizer(osProfile('linux').fs.pathCanonical)).toBeUndefined()
    expect(deleteSafetyCanonicalizer(osProfile('win32').fs.pathCanonical)).toBeUndefined()
  })

  describe('darwin mapping (real fs)', () => {
    let root: string
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-canon-')))
      mkdirSync(join(root, 'Repo'))
      symlinkSync(join(root, 'Repo'), join(root, 'link'))
    })
    afterAll(() => rmSync(root, { recursive: true, force: true }))
    const canon = deleteSafetyCanonicalizer(osProfile('darwin').fs.pathCanonical)!

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
