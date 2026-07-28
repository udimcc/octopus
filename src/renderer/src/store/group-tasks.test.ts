import { describe, it, expect } from 'vitest'
import {
  groupTasksByRepo,
  repoBasename,
  repoKeyOf,
  NO_REPO_LABEL,
  type GroupableTask
} from './group-tasks'

/** A task whose worktree carries `repoRoot`; omit to model a provisioning task. */
function task(repoRoot?: string): GroupableTask {
  if (repoRoot === undefined) return {}
  return { worktree: { provisionedBy: { repoRoot } } }
}

describe('repoBasename', () => {
  it('takes the last path segment', () => {
    expect(repoBasename('/home/u/repos/Trading')).toBe('Trading')
  })

  it('tolerates a trailing separator', () => {
    expect(repoBasename('/home/u/repos/Trading/')).toBe('Trading')
    expect(repoBasename('/home/u/repos/Trading///')).toBe('Trading')
  })

  it('handles Windows backslash separators, with or without a trailing slash', () => {
    expect(repoBasename('C:\\repos\\Trading')).toBe('Trading')
    expect(repoBasename('C:\\repos\\Trading\\')).toBe('Trading')
  })

  it('returns the raw input when there is no usable segment', () => {
    expect(repoBasename('/')).toBe('/')
    expect(repoBasename('')).toBe('')
  })

  it('returns a bare name unchanged', () => {
    expect(repoBasename('Trading')).toBe('Trading')
  })
})

describe('repoKeyOf', () => {
  it("is the task's repoRoot", () => {
    expect(repoKeyOf(task('/r/Trading'))).toBe('/r/Trading')
  })

  it("is '' for a provisioning task (no worktree yet) or an unknown task", () => {
    expect(repoKeyOf(task())).toBe('')
    expect(repoKeyOf(undefined)).toBe('')
  })
})

describe('groupTasksByRepo', () => {
  it('buckets tasks by owning repo, groups in first-appearance order', () => {
    const tasks: Record<string, GroupableTask> = {
      t1: task('/r/Trading'),
      t2: task('/r/AnotherRepo'),
      t3: task('/r/Trading')
    }
    const groups = groupTasksByRepo(['t1', 't2', 't3'], tasks)
    expect(groups).toEqual([
      { repoRoot: '/r/Trading', repoName: 'Trading', taskIds: ['t1', 't3'] },
      { repoRoot: '/r/AnotherRepo', repoName: 'AnotherRepo', taskIds: ['t2'] }
    ])
  })

  it('preserves taskOrder within each group', () => {
    const tasks: Record<string, GroupableTask> = {
      a: task('/r/X'),
      b: task('/r/X'),
      c: task('/r/X')
    }
    const groups = groupTasksByRepo(['c', 'a', 'b'], tasks)
    expect(groups[0].taskIds).toEqual(['c', 'a', 'b'])
  })

  it('appends the no-repo (provisioning) bucket LAST, whatever its position', () => {
    const tasks: Record<string, GroupableTask> = {
      p: task(), // provisioning, appears first
      t1: task('/r/Trading')
    }
    const groups = groupTasksByRepo(['p', 't1'], tasks)
    expect(groups.map((g) => g.repoRoot)).toEqual(['/r/Trading', ''])
    expect(groups[1]).toEqual({ repoRoot: '', repoName: NO_REPO_LABEL, taskIds: ['p'] })
  })

  it('skips ids absent from the task map', () => {
    const groups = groupTasksByRepo(['t1', 'ghost'], { t1: task('/r/X') })
    expect(groups).toEqual([{ repoRoot: '/r/X', repoName: 'X', taskIds: ['t1'] }])
  })

  it('is empty for no tasks', () => {
    expect(groupTasksByRepo([], {})).toEqual([])
  })
})
