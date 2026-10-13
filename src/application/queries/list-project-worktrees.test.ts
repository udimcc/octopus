import { describe, it, expect } from 'vitest'
import { listProjectWorktrees } from './list-project-worktrees'
import { createTask } from '../use-cases/create-task'
import { makeDeps, taskInput } from '../use-cases/test-fakes'

describe('listProjectWorktrees (§5.4, §6.4)', () => {
  it('lists the worktrees from the provider, annotated with branch', async () => {
    const fd = makeDeps()
    fd.worktrees.worktreeLists.set('/repo', [
      { path: '/repo', branch: 'main' },
      { path: '/repo/.worktrees/feature', branch: 'feature/x' }
    ])

    const items = await listProjectWorktrees(fd.deps, '/repo')

    expect(items).toEqual([
      { path: '/repo', branch: 'main', usedByTaskName: undefined },
      { path: '/repo/.worktrees/feature', branch: 'feature/x', usedByTaskName: undefined }
    ])
    expect(fd.worktrees.listWorktreesCalls).toEqual(['/repo'])
  })

  it('names the task currently using a worktree path', async () => {
    const fd = makeDeps()
    fd.worktrees.createdPath = '/repo/.worktrees/feature'
    await createTask(fd.deps, taskInput('Alpha', { repoDir: '/repo' }))
    fd.worktrees.worktreeLists.set('/repo', [
      { path: '/repo', branch: 'main' },
      { path: '/repo/.worktrees/feature', branch: 'feature/x' }
    ])

    const items = await listProjectWorktrees(fd.deps, '/repo')

    expect(items).toEqual([
      { path: '/repo', branch: 'main', usedByTaskName: undefined },
      { path: '/repo/.worktrees/feature', branch: 'feature/x', usedByTaskName: 'Alpha' }
    ])
  })

  it('matches the used-by task canonically (trailing slash)', async () => {
    const fd = makeDeps()
    fd.worktrees.createdPath = '/repo/.worktrees/feature/'
    await createTask(fd.deps, taskInput('Alpha', { repoDir: '/repo' }))
    fd.worktrees.worktreeLists.set('/repo', [
      { path: '/repo/.worktrees/feature', branch: 'feature/x' }
    ])

    const items = await listProjectWorktrees(fd.deps, '/repo')

    expect(items[0].usedByTaskName).toBe('Alpha')
  })

  it('returns [] when the provider has no worktrees for the root', async () => {
    const fd = makeDeps()
    const items = await listProjectWorktrees(fd.deps, '/empty')
    expect(items).toEqual([])
  })

  it('a listWorktrees rejection (deleted/moved repo) propagates uncaught', async () => {
    const fd = makeDeps()
    fd.worktrees.listWorktreesRejects.add('/gone')

    await expect(listProjectWorktrees(fd.deps, '/gone')).rejects.toThrow(/not a git repository/)
  })
})
