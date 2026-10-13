import { describe, it, expect } from 'vitest'
import { removeProject } from './remove-project'
import { createTask } from './create-task'
import { makeDeps, taskInput } from './test-fakes'

describe('removeProject (§5.4, §6.3)', () => {
  it('is blocked while a matching task exists (singular message)', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: false, error: 'Project has 1 task; delete it first' })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo' }])
  })

  it('is blocked while two tasks match (plural message)', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))
    await createTask(fd.deps, taskInput('b', { repoDir: '/repo' }))

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: false, error: 'Project has 2 tasks; delete them first' })
  })

  it('matches canonically — a trailing-slash project path still blocks on a task repoRoot without one', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo/' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    const res = removeProject(fd.deps, { path: '/repo/' })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/1 task; delete it first/)
  })

  it('canonicalizes the input path — removes a project stored without a trailing slash', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = removeProject(fd.deps, { path: '/repo/' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([])
  })

  it('is allowed when only repo-less tasks exist', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    await createTask(fd.deps, { mode: 'none', name: 'no-repo-task' })

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([])
  })

  it('is allowed when only another repo’s tasks exist', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo-a' }, { path: '/repo-b' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo-b' }))

    const res = removeProject(fd.deps, { path: '/repo-a' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo-b' }])
  })

  it('removing the last project leaves []', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/only' }] })

    const res = removeProject(fd.deps, { path: '/only' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([])
  })

  it('is an idempotent no-op success when projects was never seeded (undefined)', () => {
    const fd = makeDeps()
    expect(fd.settings.load().projects).toBeUndefined()

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toBeUndefined()
  })

  it('an unknown path is an idempotent no-op success', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = removeProject(fd.deps, { path: '/unknown' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo' }])
  })
})
