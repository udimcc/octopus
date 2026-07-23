import { describe, it, expect } from 'vitest'
import { sanitizeBranchForDir, computeWorktreePath } from './worktree-path'

describe('sanitizeBranchForDir', () => {
  it('keeps a plain branch name unchanged', () => {
    expect(sanitizeBranchForDir('feature')).toBe('feature')
  })

  it('flattens slashes so the branch becomes a single path segment', () => {
    expect(sanitizeBranchForDir('feature/add-thing')).toBe('feature-add-thing')
  })

  it('collapses runs of non-alphanumerics into a single dash', () => {
    expect(sanitizeBranchForDir('feature/Add   Thing!!')).toBe('feature-Add-Thing')
  })

  it('preserves case (branch names are case-sensitive)', () => {
    expect(sanitizeBranchForDir('Feature/CamelCase')).toBe('Feature-CamelCase')
  })

  it('trims leading and trailing separators', () => {
    expect(sanitizeBranchForDir('/wip/')).toBe('wip')
  })

  it('reduces an all-separator branch to the empty string', () => {
    expect(sanitizeBranchForDir('///')).toBe('')
  })
})

describe('computeWorktreePath', () => {
  it('produces a flat <base>/<sanitized-branch>-<short-id> path', () => {
    const path = computeWorktreePath({
      base: '/home/u/octopus_repos',
      newBranch: 'feature/login',
      taskId: 'abcdef0123456789'
    })
    expect(path).toBe('/home/u/octopus_repos/feature-login-abcdef01')
  })

  it('truncates the task id to 8 chars', () => {
    const path = computeWorktreePath({
      base: '/base',
      newBranch: 'x',
      taskId: '1234567890'
    })
    expect(path).toBe('/base/x-12345678')
  })

  it('uses just the short id when the branch sanitizes to empty', () => {
    const path = computeWorktreePath({
      base: '/base',
      newBranch: '///',
      taskId: 'abcdef0123'
    })
    expect(path).toBe('/base/abcdef01')
  })

  it('keeps two same-branch tasks distinct via the id suffix (I6)', () => {
    const a = computeWorktreePath({ base: '/base', newBranch: 'fix', taskId: 'aaaaaaaa1' })
    const b = computeWorktreePath({ base: '/base', newBranch: 'fix', taskId: 'bbbbbbbb1' })
    expect(a).not.toBe(b)
  })
})
