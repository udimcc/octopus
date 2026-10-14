import { describe, it, expect } from 'vitest'
import { Issue, IssueStatus, parseIssueStatus } from './issue'
import { asIssueId, asTaskId } from './ids'
import { InvariantViolationError } from './errors'

function create(over: Partial<Parameters<typeof Issue.create>[0]> = {}): Issue {
  return Issue.create({
    id: asIssueId('i1'),
    name: 'Fix the bug',
    description: 'desc',
    createdAt: 1,
    ...over
  })
}

describe('Issue.create / rename (name validation)', () => {
  it('rejects an empty name', () => {
    expect(() => create({ name: '' })).toThrow(InvariantViolationError)
  })

  it('rejects a whitespace-only name', () => {
    expect(() => create({ name: '   ' })).toThrow(InvariantViolationError)
  })

  it('trims leading/trailing whitespace and keeps the trimmed value', () => {
    const issue = create({ name: '  Fix the bug  ' })
    expect(issue.name).toBe('Fix the bug')
  })

  it('rename rejects an empty-after-trim name', () => {
    const issue = create()
    expect(() => issue.rename('  ')).toThrow(InvariantViolationError)
    // Rejected rename must not change the prior name.
    expect(issue.name).toBe('Fix the bug')
  })

  it('rename accepts and trims a valid non-empty name', () => {
    const issue = create()
    issue.rename('  New name  ')
    expect(issue.name).toBe('New name')
  })
})

describe('parseIssueStatus', () => {
  it('accepts all four valid status strings', () => {
    expect(parseIssueStatus('todo')).toBe(IssueStatus.Todo)
    expect(parseIssueStatus('in_progress')).toBe(IssueStatus.InProgress)
    expect(parseIssueStatus('in_review')).toBe(IssueStatus.InReview)
    expect(parseIssueStatus('done')).toBe(IssueStatus.Done)
  })

  it('rejects an invalid string', () => {
    expect(parseIssueStatus('bogus')).toBeUndefined()
  })

  it('rejects undefined, null, a number, an empty string, and an object', () => {
    expect(parseIssueStatus(undefined)).toBeUndefined()
    expect(parseIssueStatus(null)).toBeUndefined()
    expect(parseIssueStatus(123)).toBeUndefined()
    expect(parseIssueStatus('')).toBeUndefined()
    expect(parseIssueStatus({ status: 'todo' })).toBeUndefined()
  })
})

describe('Issue — initial state', () => {
  it('starts unbound, in Todo, with updatedAt equal to createdAt', () => {
    const issue = create({ createdAt: 7 })
    expect(issue.status).toBe(IssueStatus.Todo)
    expect(issue.taskId).toBeUndefined()
    expect(issue.updatedAt).toBe(issue.createdAt)
    expect(issue.updatedAt).toBe(7)
  })
})

describe('Issue setters mutate exactly one field', () => {
  it('setDescription changes only description', () => {
    const issue = create()
    const before = issue.toSnapshot()
    issue.setDescription('new desc')
    expect(issue.description).toBe('new desc')
    expect(issue.name).toBe(before.name)
    expect(issue.projectPath).toBe(before.projectPath)
    expect(issue.status).toBe(before.status)
    expect(issue.taskId).toBe(before.taskId)
    expect(issue.updatedAt).toBe(before.updatedAt)
  })

  it('setProject changes only projectPath (set then clear)', () => {
    const issue = create()
    const before = issue.toSnapshot()
    issue.setProject('/repo/main')
    expect(issue.projectPath).toBe('/repo/main')
    expect(issue.name).toBe(before.name)
    expect(issue.description).toBe(before.description)
    expect(issue.status).toBe(before.status)
    expect(issue.taskId).toBe(before.taskId)

    issue.setProject(undefined)
    expect(issue.projectPath).toBeUndefined()
  })

  it('setStatus changes only status', () => {
    const issue = create()
    const before = issue.toSnapshot()
    issue.setStatus(IssueStatus.Done)
    expect(issue.status).toBe(IssueStatus.Done)
    expect(issue.name).toBe(before.name)
    expect(issue.description).toBe(before.description)
    expect(issue.projectPath).toBe(before.projectPath)
    expect(issue.taskId).toBe(before.taskId)
    expect(issue.updatedAt).toBe(before.updatedAt)
  })

  it('touch changes only updatedAt', () => {
    const issue = create()
    const before = issue.toSnapshot()
    issue.touch(999)
    expect(issue.updatedAt).toBe(999)
    expect(issue.name).toBe(before.name)
    expect(issue.description).toBe(before.description)
    expect(issue.projectPath).toBe(before.projectPath)
    expect(issue.status).toBe(before.status)
    expect(issue.taskId).toBe(before.taskId)
  })
})

describe('Issue.bindTo / clearBinding (mechanical — invariants live in Workspace)', () => {
  // Per issue.ts's own doc comment: these two setters are not meant to be called from
  // outside Workspace — production code must only reach them via Workspace.bindIssue /
  // unbindIssue / restoreIssueBinding / hydrate. This is a one-line test of the raw
  // primitive itself, not a demonstration of bypassing that architecture rule elsewhere.
  it('round-trips the raw taskId field, and toSnapshot reflects each state', () => {
    const issue = create()
    expect(issue.toSnapshot().taskId).toBeUndefined()

    issue.bindTo(asTaskId('t1'))
    expect(issue.taskId).toBe(asTaskId('t1'))
    expect(issue.toSnapshot().taskId).toBe(asTaskId('t1'))

    issue.clearBinding()
    expect(issue.taskId).toBeUndefined()
    expect(issue.toSnapshot().taskId).toBeUndefined()
  })
})

describe('Issue snapshot round trip', () => {
  it('fromSnapshot(toSnapshot()) preserves every field — unbound issue', () => {
    const issue = create({ name: 'Original', description: 'd', createdAt: 10 })
    issue.touch(20)
    const snap = issue.toSnapshot()
    const restored = Issue.fromSnapshot(snap)

    expect(restored.id).toBe(issue.id)
    expect(restored.name).toBe(issue.name)
    expect(restored.description).toBe(issue.description)
    expect(restored.projectPath).toBeUndefined()
    expect(restored.status).toBe(IssueStatus.Todo)
    expect(restored.taskId).toBeUndefined()
    expect(restored.createdAt).toBe(issue.createdAt)
    expect(restored.updatedAt).toBe(20)
  })

  it('fromSnapshot(toSnapshot()) preserves every field — bound issue with a project', () => {
    const issue = create({ projectPath: '/repo/main', createdAt: 5 })
    issue.bindTo(asTaskId('t1'))
    issue.setStatus(IssueStatus.InProgress)
    issue.touch(50)
    const snap = issue.toSnapshot()
    const restored = Issue.fromSnapshot(snap)

    expect(restored.projectPath).toBe('/repo/main')
    expect(restored.taskId).toBe(asTaskId('t1'))
    expect(restored.status).toBe(IssueStatus.InProgress)
    expect(restored.createdAt).toBe(5)
    expect(restored.updatedAt).toBe(50)
  })

  it('fromSnapshot does not re-validate the name (a stale/invalid persisted row still hydrates)', () => {
    const issue = create()
    const snap = { ...issue.toSnapshot(), name: '   ' }
    const restored = Issue.fromSnapshot(snap)
    expect(restored.name).toBe('   ')
  })
})
