import { describe, it, expect } from 'vitest'
import { setProjectDefaultBranch } from './set-project-default-branch'
import { makeDeps } from './test-fakes'

describe('setProjectDefaultBranch (§5.4, §6.3)', () => {
  it('sets the default branch on the matching project', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = setProjectDefaultBranch(fd.deps, { path: '/repo', defaultBranch: 'develop' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo', defaultBranch: 'develop' }])
  })

  it('matches canonically (trailing slash on the stored project)', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo/' }] })

    const res = setProjectDefaultBranch(fd.deps, { path: '/repo', defaultBranch: 'develop' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo/', defaultBranch: 'develop' }])
  })

  it('clears defaultBranch back to undefined on an empty value', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo', defaultBranch: 'main' }] })

    const res = setProjectDefaultBranch(fd.deps, { path: '/repo', defaultBranch: '' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo', defaultBranch: undefined }])
  })

  it('clears defaultBranch on a whitespace-only value (trimmed to empty)', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo', defaultBranch: 'main' }] })

    setProjectDefaultBranch(fd.deps, { path: '/repo', defaultBranch: '   ' })

    expect(fd.settings.load().projects).toEqual([{ path: '/repo', defaultBranch: undefined }])
  })

  it('clears defaultBranch when defaultBranch is omitted entirely', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo', defaultBranch: 'main' }] })

    setProjectDefaultBranch(fd.deps, { path: '/repo' })

    expect(fd.settings.load().projects).toEqual([{ path: '/repo', defaultBranch: undefined }])
  })

  it('errors for an unknown path and saves nothing', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = setProjectDefaultBranch(fd.deps, { path: '/unknown', defaultBranch: 'develop' })

    expect(res).toEqual({ ok: false, error: 'Unknown project: /unknown' })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo' }])
  })

  it('errors when projects was never seeded (undefined)', () => {
    const fd = makeDeps()
    expect(fd.settings.load().projects).toBeUndefined()

    const res = setProjectDefaultBranch(fd.deps, { path: '/repo', defaultBranch: 'develop' })

    expect(res).toEqual({ ok: false, error: 'Unknown project: /repo' })
  })

  it('leaves sibling projects untouched', () => {
    const fd = makeDeps()
    fd.settings.save({
      projects: [{ path: '/repo-a' }, { path: '/repo-b', defaultBranch: 'main' }]
    })

    setProjectDefaultBranch(fd.deps, { path: '/repo-a', defaultBranch: 'develop' })

    expect(fd.settings.load().projects).toEqual([
      { path: '/repo-a', defaultBranch: 'develop' },
      { path: '/repo-b', defaultBranch: 'main' }
    ])
  })
})
