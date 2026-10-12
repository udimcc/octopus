import { describe, it, expect } from 'vitest'
import { taskNameToBranchSlug } from './slug'

describe('taskNameToBranchSlug', () => {
  it('lowercases and underscore-joins words', () => {
    expect(taskNameToBranchSlug('Add Feature 1')).toBe('add_feature_1')
  })

  it('preserves branch namespaces via slashes', () => {
    expect(taskNameToBranchSlug('Feature / Add Feature 1')).toBe('feature/add_feature_1')
  })

  it('collapses runs of punctuation and underscores into a single underscore', () => {
    expect(taskNameToBranchSlug('fix:  the___bug!!!')).toBe('fix_the_bug')
  })

  it('trims leading and trailing separators', () => {
    expect(taskNameToBranchSlug('  /Hello/  ')).toBe('hello')
    expect(taskNameToBranchSlug('__Hello-World--')).toBe('hello_world')
  })

  it('collapses repeated slashes and separators around them', () => {
    expect(taskNameToBranchSlug('a // b')).toBe('a/b')
    expect(taskNameToBranchSlug('a / - / b')).toBe('a/b')
    expect(taskNameToBranchSlug('feature_ / _x')).toBe('feature/x')
  })

  it('returns empty string for names with no slug characters', () => {
    expect(taskNameToBranchSlug('!!! ???')).toBe('')
  })

  it('converts typed dashes to underscores, keeping digits and namespaces', () => {
    expect(taskNameToBranchSlug('bugfix/issue-42')).toBe('bugfix/issue_42')
  })
})
