import { describe, it, expect } from 'vitest'
import {
  isNonEmptyString,
  isSplitDirection,
  isSplitPath,
  parseCreateIssueInput,
  parseIssueStatusInput
} from './command-validation'
import { IssueStatus } from '../domain/issue'

describe('parseIssueStatusInput', () => {
  it('returns {} for undefined, the parsed status for valid values, an error otherwise', () => {
    expect(parseIssueStatusInput(undefined)).toEqual({})
    expect(parseIssueStatusInput('in_review')).toEqual({ status: IssueStatus.InReview })
    expect(parseIssueStatusInput('bogus').error).toContain('bogus')
    expect(parseIssueStatusInput(null).error).toBeDefined()
  })
})

describe('parseCreateIssueInput', () => {
  it('builds the command input and forwards projectPath', () => {
    expect(
      parseCreateIssueInput({ name: 'n', description: 'd', projectPath: '/p', status: 'done' })
    ).toEqual({
      input: { name: 'n', description: 'd', projectPath: '/p', status: IssueStatus.Done }
    })
  })

  it('rejects non-string name or description', () => {
    expect(parseCreateIssueInput({ name: 1, description: 'd' }).error).toBe(
      'Invalid issue name or description'
    )
    expect(parseCreateIssueInput({ name: 'n', description: undefined }).error).toBeDefined()
  })

  it('rejects an invalid status', () => {
    expect(parseCreateIssueInput({ name: 'n', description: 'd', status: 'x' }).error).toContain(
      'Invalid issue status'
    )
  })
})

describe('simple guards', () => {
  it('isNonEmptyString', () => {
    expect(isNonEmptyString('a')).toBe(true)
    expect(isNonEmptyString('')).toBe(false)
    expect(isNonEmptyString(3)).toBe(false)
  })
  it('isSplitDirection', () => {
    expect(isSplitDirection('row')).toBe(true)
    expect(isSplitDirection('col')).toBe(true)
    expect(isSplitDirection('diag')).toBe(false)
  })
  it('isSplitPath accepts only arrays of a/b', () => {
    expect(isSplitPath([])).toBe(true)
    expect(isSplitPath(['a', 'b'])).toBe(true)
    expect(isSplitPath(['a', 'c'])).toBe(false)
    expect(isSplitPath('ab')).toBe(false)
  })
})
