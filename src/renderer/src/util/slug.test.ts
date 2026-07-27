import { describe, it, expect } from 'vitest'
import { taskNameToBranchSlug } from './slug'

describe('taskNameToBranchSlug', () => {
  it('lowercases and dash-joins words', () => {
    expect(taskNameToBranchSlug('Add Feature 1')).toBe('add-feature-1')
  })

  it('preserves branch namespaces via slashes', () => {
    expect(taskNameToBranchSlug('Feature / Add Feature 1')).toBe('feature/add-feature-1')
  })

  it('collapses runs of punctuation into a single dash', () => {
    expect(taskNameToBranchSlug('fix:  the___bug!!!')).toBe('fix-the-bug')
  })

  it('trims leading and trailing separators', () => {
    expect(taskNameToBranchSlug('  /Hello/  ')).toBe('hello')
  })

  it('collapses repeated slashes and dashes around them', () => {
    expect(taskNameToBranchSlug('a // b')).toBe('a/b')
    expect(taskNameToBranchSlug('a / - / b')).toBe('a/b')
  })

  it('returns empty string for names with no slug characters', () => {
    expect(taskNameToBranchSlug('!!! ???')).toBe('')
  })

  it('keeps existing digits and hyphenated slugs intact', () => {
    expect(taskNameToBranchSlug('bugfix/issue-42')).toBe('bugfix/issue-42')
  })
})
