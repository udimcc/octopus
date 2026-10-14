import { describe, it, expect } from 'vitest'
import { groupIssuesByStatus } from './group-issues'
import type { IssueDTO } from '../../../shared/dto'

function issue(id: string, over: Partial<IssueDTO> = {}): IssueDTO {
  return {
    id,
    name: id,
    description: '',
    status: 'todo',
    createdAt: 1000,
    updatedAt: 1000,
    ...over
  }
}

describe('groupIssuesByStatus', () => {
  it('always returns all four groups, in the fixed Todo/In progress/In review/Done order', () => {
    const groups = groupIssuesByStatus([])
    expect(groups.map((g) => g.status)).toEqual(['todo', 'in_progress', 'in_review', 'done'])
    for (const g of groups) expect(g.issues).toEqual([])
  })

  it('buckets each issue into its own status group only', () => {
    const todo = issue('t1', { status: 'todo' })
    const inProgress = issue('p1', { status: 'in_progress' })
    const inReview = issue('r1', { status: 'in_review' })
    const done = issue('d1', { status: 'done' })
    const groups = groupIssuesByStatus([todo, inProgress, inReview, done])
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g.issues]))
    expect(byStatus.todo).toEqual([todo])
    expect(byStatus.in_progress).toEqual([inProgress])
    expect(byStatus.in_review).toEqual([inReview])
    expect(byStatus.done).toEqual([done])
  })

  it('sorts issues within a group newest first by createdAt', () => {
    const oldest = issue('a', { createdAt: 1000 })
    const middle = issue('b', { createdAt: 2000 })
    const newest = issue('c', { createdAt: 3000 })
    // Deliberately seeded out of order.
    const groups = groupIssuesByStatus([middle, oldest, newest])
    const todo = groups.find((g) => g.status === 'todo')
    expect(todo?.issues.map((i) => i.id)).toEqual(['c', 'b', 'a'])
  })

  it('breaks a createdAt tie by id ascending', () => {
    const b = issue('b', { createdAt: 1000 })
    const a = issue('a', { createdAt: 1000 })
    const groups = groupIssuesByStatus([b, a])
    const todo = groups.find((g) => g.status === 'todo')
    expect(todo?.issues.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const issues = [issue('b', { createdAt: 1000 }), issue('a', { createdAt: 2000 })]
    const copy = [...issues]
    groupIssuesByStatus(issues)
    expect(issues).toEqual(copy)
  })
})
