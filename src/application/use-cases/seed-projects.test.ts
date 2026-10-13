import { describe, it, expect } from 'vitest'
import { seedProjects } from './seed-projects'
import { createTask } from './create-task'
import { makeDeps, taskInput } from './test-fakes'

describe('seedProjects (§6.3 boot seed)', () => {
  it('seeds a project per distinct task repo root when projects is absent', async () => {
    const fd = makeDeps()
    expect(fd.settings.load().projects).toBeUndefined()
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))
    fd.worktrees.inspectResults.set('/repo', { root: '/repo', defaultBranch: 'main' })

    await seedProjects(fd.deps)

    expect(fd.settings.load().projects).toEqual([{ path: '/repo', defaultBranch: 'main' }])
  })

  it('does nothing when projects is already an empty array (user removed everything)', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    await seedProjects(fd.deps)

    expect(fd.settings.load().projects).toEqual([])
  })

  it('does nothing when projects is already populated', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/existing' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    await seedProjects(fd.deps)

    expect(fd.settings.load().projects).toEqual([{ path: '/existing' }])
  })

  it('skips a repo whose inspectRepo rejects (deleted/moved) without saving it', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('a', { repoDir: '/gone' }))
    fd.worktrees.inspectRejects.add('/gone')

    await seedProjects(fd.deps)

    // No candidates survive → nothing saved, projects stays absent.
    expect(fd.settings.saveCalls).toEqual([])
    expect(fd.settings.load().projects).toBeUndefined()
  })

  it('collapses a linked-worktree task root into the main checkout via inspectRepo', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo/.worktrees/linked' }))
    fd.worktrees.inspectResults.set('/repo/.worktrees/linked', { root: '/repo/main' })

    await seedProjects(fd.deps)

    expect(fd.settings.load().projects).toEqual([{ path: '/repo/main' }])
  })

  it('dedupes two tasks whose roots resolve to the same canonical main checkout', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo/.worktrees/one' }))
    await createTask(fd.deps, taskInput('b', { repoDir: '/repo/.worktrees/two' }))
    fd.worktrees.inspectResults.set('/repo/.worktrees/one', { root: '/repo/main' })
    fd.worktrees.inspectResults.set('/repo/.worktrees/two', { root: '/repo/main/' })

    await seedProjects(fd.deps)

    expect(fd.settings.load().projects).toEqual([{ path: '/repo/main' }])
  })

  it('ignores repo-less tasks', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, { mode: 'none', name: 'no-repo-task' })

    await seedProjects(fd.deps)

    expect(fd.settings.saveCalls).toEqual([])
    expect(fd.settings.load().projects).toBeUndefined()
    expect(fd.worktrees.inspectCalls).toEqual([])
  })

  it('saves nothing when there are no tasks at all', async () => {
    const fd = makeDeps()

    await seedProjects(fd.deps)

    expect(fd.settings.saveCalls).toEqual([])
    expect(fd.settings.load().projects).toBeUndefined()
  })

  it('seeds the good repos and silently skips a bad one in between', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo-a' }))
    await createTask(fd.deps, taskInput('b', { repoDir: '/repo-bad' }))
    await createTask(fd.deps, taskInput('c', { repoDir: '/repo-c' }))
    fd.worktrees.inspectResults.set('/repo-a', { root: '/repo-a' })
    fd.worktrees.inspectRejects.add('/repo-bad')
    fd.worktrees.inspectResults.set('/repo-c', { root: '/repo-c' })

    await seedProjects(fd.deps)

    expect(fd.settings.load().projects).toEqual([{ path: '/repo-a' }, { path: '/repo-c' }])
  })

  it('is skipped entirely when settings.loadFailed() is true, even though projects is absent', async () => {
    const fd = makeDeps()
    fd.settings.simulateLoadFailed = true
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))
    fd.worktrees.inspectResults.set('/repo', { root: '/repo' })

    await seedProjects(fd.deps)

    expect(fd.settings.saveCalls).toEqual([])
    expect(fd.settings.load().projects).toBeUndefined()
    expect(fd.worktrees.inspectCalls).toEqual([])
  })
})
