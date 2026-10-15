import { describe, it, expect } from 'vitest'
import { normalizeJiraIssueKey, isJiraIssueKey } from './jira-key'

describe('normalizeJiraIssueKey', () => {
  it('accepts a well-formed key unchanged', () => {
    expect(normalizeJiraIssueKey('PROJ-123')).toBe('PROJ-123')
  })

  it('uppercases a lowercase key', () => {
    expect(normalizeJiraIssueKey('proj-123')).toBe('PROJ-123')
  })

  it('trims leading and trailing whitespace', () => {
    expect(normalizeJiraIssueKey('  PROJ-123  ')).toBe('PROJ-123')
  })

  it('rejects a key missing the number', () => {
    expect(normalizeJiraIssueKey('PROJ-')).toBeUndefined()
    expect(normalizeJiraIssueKey('PROJ')).toBeUndefined()
  })

  it('rejects a comma-separated list of keys', () => {
    expect(normalizeJiraIssueKey('PROJ-1,PROJ-2')).toBeUndefined()
  })

  it('rejects a leading zero in the number', () => {
    expect(normalizeJiraIssueKey('PROJ-007')).toBeUndefined()
  })

  it('rejects internal whitespace (not just leading/trailing)', () => {
    expect(normalizeJiraIssueKey('PROJ - 123')).toBeUndefined()
  })
})

describe('isJiraIssueKey', () => {
  it('is true for a well-formed key', () => {
    expect(isJiraIssueKey('PROJ-123')).toBe(true)
  })

  it('is true for a lowercase key (normalized before the check)', () => {
    expect(isJiraIssueKey('proj-123')).toBe(true)
  })

  it('is false for a key missing the number', () => {
    expect(isJiraIssueKey('PROJ-')).toBe(false)
  })

  it('is false for a comma-separated list', () => {
    expect(isJiraIssueKey('PROJ-1,PROJ-2')).toBe(false)
  })
})
