import { describe, it, expect } from 'vitest'
import { addProject } from './add-project'
import { makeDeps } from './test-fakes'

describe('addProject (§5.4, §6.3, §6.4)', () => {
  it('resolves the picked directory to its main root via inspectRepo and saves it', async () => {
    const fd = makeDeps()
    fd.worktrees.inspectResults.set('/picked', { root: '/repo/main', defaultBranch: 'main' })

    const res = await addProject(fd.deps, { dir: '/picked' })

    expect(res).toEqual({ ok: true, project: { path: '/repo/main', defaultBranch: 'main' } })
    expect(fd.worktrees.inspectCalls).toEqual(['/picked'])
    expect(fd.settings.load().projects).toEqual([{ path: '/repo/main', defaultBranch: 'main' }])
  })

  it('a duplicate (same canonical root) returns the existing project and saves nothing', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo/main', defaultBranch: 'main' }] })
    fd.worktrees.inspectResults.set('/picked-again', { root: '/repo/main/', defaultBranch: 'main' })
    const saveCallsBefore = fd.settings.saveCalls.length

    const res = await addProject(fd.deps, { dir: '/picked-again' })

    expect(res).toEqual({ ok: true, project: { path: '/repo/main', defaultBranch: 'main' } })
    // settings.save was never called a second time — same reference back.
    expect(fd.settings.saveCalls).toHaveLength(saveCallsBefore)
    expect(fd.settings.load().projects).toEqual([{ path: '/repo/main', defaultBranch: 'main' }])
  })

  it('a linked-worktree path dedupes to the main entry (canonical trailing slash too)', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo/main/' }] })
    fd.worktrees.inspectResults.set('/repo/.worktrees/linked', { root: '/repo/main' })

    const res = await addProject(fd.deps, { dir: '/repo/.worktrees/linked' })

    expect(res).toEqual({ ok: true, project: { path: '/repo/main/' } })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo/main/' }])
  })

  it('an inspectRepo rejection propagates (turned into { ok: false, error } by the command loop)', async () => {
    const fd = makeDeps()
    fd.worktrees.inspectRejects.add('/not-a-repo')

    await expect(addProject(fd.deps, { dir: '/not-a-repo' })).rejects.toThrow(
      /not a git repository/
    )
  })

  it('adding when projects is undefined creates the list', async () => {
    const fd = makeDeps()
    expect(fd.settings.load().projects).toBeUndefined()
    fd.worktrees.inspectResults.set('/picked', { root: '/repo/main' })

    await addProject(fd.deps, { dir: '/picked' })

    expect(fd.settings.load().projects).toEqual([{ path: '/repo/main' }])
  })
})
