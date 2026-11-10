import { describe, it, expect } from 'vitest'
import { issueToMarkdown } from './format'
import type { ControlIssue } from '../shared/control-protocol'

const issue = (over: Partial<ControlIssue> = {}): ControlIssue => ({
  id: 'i1',
  name: 'TM-1: Fix rejects',
  status: 'todo',
  description: 'Rule:\n\n- a\n- b\n',
  ...over
})

describe('issueToMarkdown', () => {
  it('renders title, metadata and the description with real newlines', () => {
    expect(issueToMarkdown({ issue: issue({ project: '/repos/app' }) })).toBe(
      '# TM-1: Fix rejects\n\n- Id: i1\n- Status: todo\n- Project: /repos/app\n\n' +
        '## Description\n\nRule:\n\n- a\n- b\n'
    )
  })

  it('adds blocked reasons when set, and never the task id', () => {
    const md = issueToMarkdown({
      issue: issue({ status: 'blocked', blockedReasons: 'Waiting for Noam', taskId: 't9' })
    })
    expect(md).toContain(
      '- Status: blocked\n\n## Blocked reasons\n\nWaiting for Noam\n\n## Description'
    )
    expect(md).not.toContain('t9')
  })

  it('omits empty project and blank blocked reasons; marks an empty description', () => {
    const md = issueToMarkdown({ issue: issue({ description: '  ', blockedReasons: ' ' }) })
    expect(md).toBe(
      '# TM-1: Fix rejects\n\n- Id: i1\n- Status: todo\n\n## Description\n\n(no description)\n'
    )
  })
})
