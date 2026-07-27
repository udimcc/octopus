import { describe, it, expect } from 'vitest'
import { validateWorktreePath, assertSafeToDelete, type PathProbe } from './path-safety'

const dirProbe: PathProbe = { isDirectory: () => true, looksLikeGitWorktree: () => true }
const notDirProbe: PathProbe = { isDirectory: () => false, looksLikeGitWorktree: () => false }
const dirButNotGit: PathProbe = { isDirectory: () => true, looksLikeGitWorktree: () => false }

describe('validateWorktreePath (§6.4)', () => {
  it('accepts an absolute, existing directory that looks like a worktree', () => {
    expect(validateWorktreePath('/repo/wt', dirProbe)).toEqual({ ok: true })
  })

  it('trims surrounding whitespace before validating', () => {
    expect(validateWorktreePath('  /repo/wt\n', dirProbe).ok).toBe(true)
  })

  it('rejects an empty path (script printed nothing)', () => {
    const r = validateWorktreePath('   ', dirProbe)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no worktree path/)
  })

  it('rejects a relative path', () => {
    const r = validateWorktreePath('relative/wt', dirProbe)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not absolute/)
  })

  it('rejects a path that does not exist / is not a directory', () => {
    const r = validateWorktreePath('/nope', notDirProbe)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/does not exist or is not a directory/)
  })

  it('accepts but WARNS when the dir does not look like a git worktree (§6.4: never rejects on this)', () => {
    const r = validateWorktreePath('/some/dir', dirButNotGit)
    expect(r.ok).toBe(true)
    expect(r.warning).toMatch(/does not look like a git worktree/)
  })
})

describe('assertSafeToDelete (§6.4)', () => {
  const repoRoot = '/home/u/repo'

  it('permits deleting the exact stored path outside the repo', () => {
    expect(() =>
      assertSafeToDelete({
        candidate: '/home/u/worktrees/task-1',
        storedPath: '/home/u/worktrees/task-1',
        repoRoot
      })
    ).not.toThrow()
  })

  it('refuses when the candidate differs from the stored path', () => {
    expect(() =>
      assertSafeToDelete({
        candidate: '/home/u/worktrees/other',
        storedPath: '/home/u/worktrees/task-1',
        repoRoot
      })
    ).toThrow(/differs from the stored worktree path/)
  })

  it('refuses a non-absolute candidate', () => {
    expect(() => assertSafeToDelete({ candidate: 'rel', storedPath: 'rel', repoRoot })).toThrow(
      /non-absolute/
    )
  })

  it('refuses the filesystem root', () => {
    expect(() => assertSafeToDelete({ candidate: '/', storedPath: '/', repoRoot })).toThrow(
      /filesystem root/
    )
  })

  it('refuses the repo root itself (even with a trailing slash)', () => {
    expect(() =>
      assertSafeToDelete({ candidate: '/home/u/repo', storedPath: '/home/u/repo', repoRoot })
    ).toThrow(/repo root/)
    expect(() =>
      assertSafeToDelete({ candidate: '/home/u/repo/', storedPath: '/home/u/repo/', repoRoot })
    ).toThrow(/repo root/)
  })

  it('refuses an ancestor of the repo root', () => {
    expect(() =>
      assertSafeToDelete({ candidate: '/home/u', storedPath: '/home/u', repoRoot })
    ).toThrow(/ancestor of the repo root/)
    expect(() => assertSafeToDelete({ candidate: '/home', storedPath: '/home', repoRoot })).toThrow(
      /ancestor of the repo root/
    )
  })

  it('permits a sibling that merely shares a name prefix with the repo root', () => {
    // `/home/u/repo-backups` is NOT an ancestor of `/home/u/repo` — the segment
    // boundary check must not treat it as one.
    expect(() =>
      assertSafeToDelete({
        candidate: '/home/u/repo-backups',
        storedPath: '/home/u/repo-backups',
        repoRoot
      })
    ).not.toThrow()
  })

  it('permits a descendant of the repo root (a worktree living inside the repo)', () => {
    expect(() =>
      assertSafeToDelete({
        candidate: '/home/u/repo/.worktrees/t1',
        storedPath: '/home/u/repo/.worktrees/t1',
        repoRoot
      })
    ).not.toThrow()
  })
})
