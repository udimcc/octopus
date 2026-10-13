import { describe, it, expect } from 'vitest'
import { updateSettings } from './update-settings'
import { makeDeps } from './test-fakes'
import type { SettingsPatch } from '../commands'

describe('updateSettings (§6.3, §5.4)', () => {
  it('saves a plain patch and mirrors defaultSessionTypeId into the workspace config', () => {
    const fd = makeDeps()

    updateSettings(fd.deps, { defaultSessionTypeId: 'other-type' })

    expect(fd.settings.load().defaultSessionTypeId).toBe('other-type')
    expect(fd.workspace.config.defaultSessionTypeId).toBe('other-type')
  })

  it('strips a stray projects key from the patch before saving (bypass guard)', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/existing' }] })

    const patch = {
      worktree: { location: '/new' },
      projects: [{ path: '/sneaky' }]
    } as SettingsPatch & {
      projects: unknown
    }
    updateSettings(fd.deps, patch)

    // The dedicated project path, not updateSettings, is the only sanctioned mutator.
    expect(fd.settings.load().projects).toEqual([{ path: '/existing' }])
    expect(fd.settings.load().worktree.location).toBe('/new')
  })

  it('leaves the workspace defaultSessionTypeId unchanged when the patch omits it', () => {
    const fd = makeDeps()
    const before = fd.workspace.config.defaultSessionTypeId

    updateSettings(fd.deps, { worktree: { location: '/elsewhere' } })

    expect(fd.workspace.config.defaultSessionTypeId).toBe(before)
  })
})
