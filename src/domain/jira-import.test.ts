import { describe, it, expect } from 'vitest'
import {
  composeJiraIssue,
  classifyJiraIssue,
  orderSprints,
  matchesSprintFilter,
  type JiraIssue,
  type JiraSprint
} from './jira-import'
import { Issue, IssueSource } from './issue'
import { asIssueId } from './ids'

function jiraIssue(over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'PROJ-1',
    summary: 'Fix the bug',
    descriptionMarkdown: 'Some description',
    dodMarkdown: '',
    status: 'To Do',
    priority: 'Medium',
    type: 'Bug',
    created: '2026-10-01T00:00:00.000+0300',
    projectKey: 'PROJ',
    sprints: [],
    ...over
  }
}

function sprint(over: Partial<JiraSprint> = {}): JiraSprint {
  return { id: 1, name: 'Sprint 1', state: 'active', ...over }
}

function jiraIssueRecord(
  over: Partial<Parameters<typeof Issue.create>[0]> = {},
  jiraKey = 'PROJ-1'
): Issue {
  return Issue.create({
    id: asIssueId('i1'),
    name: `${jiraKey}: Fix the bug`,
    description: 'Some description',
    createdAt: 1,
    source: IssueSource.Jira,
    jiraKey,
    ...over
  })
}

describe('composeJiraIssue', () => {
  it('leaves out the DOD section entirely when dodMarkdown is empty', () => {
    const composed = composeJiraIssue(
      jiraIssue({ descriptionMarkdown: 'Body text', dodMarkdown: '' })
    )
    expect(composed.description).toBe('Body text')
    expect(composed.description).not.toContain('Definition of Done')
  })

  it('leaves out the DOD section when dodMarkdown is whitespace-only', () => {
    const composed = composeJiraIssue(
      jiraIssue({ descriptionMarkdown: 'Body text', dodMarkdown: '   \n  ' })
    )
    expect(composed.description).toBe('Body text')
  })

  it('produces just the DOD section (no leading blank line) when descriptionMarkdown is empty', () => {
    const composed = composeJiraIssue(
      jiraIssue({ descriptionMarkdown: '', dodMarkdown: 'CI passes' })
    )
    expect(composed.description).toBe('## Definition of Done\nCI passes')
  })

  it('produces just the DOD section when descriptionMarkdown is whitespace-only', () => {
    const composed = composeJiraIssue(
      jiraIssue({ descriptionMarkdown: '   ', dodMarkdown: 'CI passes' })
    )
    expect(composed.description).toBe('## Definition of Done\nCI passes')
  })

  it('appends the DOD section after a blank line when both are non-empty', () => {
    const composed = composeJiraIssue(
      jiraIssue({ descriptionMarkdown: 'Body text', dodMarkdown: 'CI passes' })
    )
    expect(composed.description).toBe('Body text\n\n## Definition of Done\nCI passes')
  })

  it('names the issue "KEY: Summary", normalized exactly like Issue.create would', () => {
    const raw = jiraIssue({ key: 'PROJ-42', summary: '  Fix the bug  ' })
    const composed = composeJiraIssue(raw)
    const viaIssueCreate = Issue.create({
      id: asIssueId('i1'),
      name: `${raw.key}: ${raw.summary}`,
      description: '',
      createdAt: 1
    })
    expect(composed.name).toBe(viaIssueCreate.name)
  })
})

describe('classifyJiraIssue', () => {
  it('classifies as new when no existing issue has that jiraKey', () => {
    const composed = composeJiraIssue(jiraIssue())
    const result = classifyJiraIssue(composed, 'PROJ-1', [])
    expect(result.kind).toBe('new')
  })

  it('classifies as duplicate when the stored name and description both match', () => {
    const raw = jiraIssue()
    const composed = composeJiraIssue(raw)
    const existing = jiraIssueRecord({ name: composed.name, description: composed.description })
    const result = classifyJiraIssue(composed, raw.key, [existing])
    expect(result.kind).toBe('duplicate')
    expect(result).toMatchObject({ issueId: existing.id, issueName: existing.name })
  })

  it('classifies as conflict when only the name differs', () => {
    const raw = jiraIssue()
    const composed = composeJiraIssue(raw)
    const existing = jiraIssueRecord({
      name: 'Something else entirely',
      description: composed.description
    })
    const result = classifyJiraIssue(composed, raw.key, [existing])
    expect(result.kind).toBe('conflict')
  })

  it('classifies as conflict when only the description differs', () => {
    const raw = jiraIssue()
    const composed = composeJiraIssue(raw)
    const existing = jiraIssueRecord({
      name: composed.name,
      description: 'A completely different description'
    })
    const result = classifyJiraIssue(composed, raw.key, [existing])
    expect(result.kind).toBe('conflict')
  })

  it('a locally-edited import (renamed after import) classifies as conflict', () => {
    const raw = jiraIssue()
    const composed = composeJiraIssue(raw)
    const existing = jiraIssueRecord({ name: composed.name, description: composed.description })
    existing.rename('Renamed locally')
    const result = classifyJiraIssue(composed, raw.key, [existing])
    expect(result.kind).toBe('conflict')
  })

  it('a locally-edited import (re-described after import) classifies as conflict', () => {
    const raw = jiraIssue()
    const composed = composeJiraIssue(raw)
    const existing = jiraIssueRecord({ name: composed.name, description: composed.description })
    existing.setDescription('Re-described locally')
    const result = classifyJiraIssue(composed, raw.key, [existing])
    expect(result.kind).toBe('conflict')
  })

  it('a description/DOD with trailing whitespace and 3+ blank lines re-composes identically, classifying as duplicate (not conflict)', () => {
    const raw = jiraIssue({
      descriptionMarkdown: 'Line one.   \nLine two.\t\n\n\n\n   \nLine three.  ',
      dodMarkdown: 'Step one.  \n\n\n\nStep two.\t'
    })
    const composed = composeJiraIssue(raw)
    const existing = jiraIssueRecord({ name: composed.name, description: composed.description })

    // Re-fetching the same Jira issue (the "re-preview" path) must recompose
    // byte-identical output, so it classifies as duplicate, not conflict.
    const recomposed = composeJiraIssue(raw)
    expect(recomposed).toEqual(composed)
    const result = classifyJiraIssue(recomposed, raw.key, [existing])
    expect(result.kind).toBe('duplicate')
  })

  it('deleting the matching issue makes the same jiraKey classify as new again', () => {
    const raw = jiraIssue()
    const composed = composeJiraIssue(raw)
    const existing = jiraIssueRecord({ name: composed.name, description: composed.description })
    const existingIssues = [existing]
    expect(classifyJiraIssue(composed, raw.key, existingIssues).kind).toBe('duplicate')
    // "Deleting" the issue is removing it from the existingIssues list passed in.
    const afterDelete = existingIssues.filter((i) => i.id !== existing.id)
    expect(classifyJiraIssue(composed, raw.key, afterDelete).kind).toBe('new')
  })
})

describe('orderSprints', () => {
  it('dedupes by id — the later occurrence wins', () => {
    const first = sprint({ id: 1, name: 'First', state: 'active' })
    const second = sprint({ id: 1, name: 'Second', state: 'active' })
    const result = orderSprints([first, second])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Second')
  })

  it('orders active before future before closed', () => {
    const closed = sprint({ id: 1, name: 'Closed', state: 'closed' })
    const future = sprint({ id: 2, name: 'Future', state: 'future' })
    const active = sprint({ id: 3, name: 'Active', state: 'active' })
    const result = orderSprints([closed, future, active])
    expect(result.map((s) => s.state)).toEqual(['active', 'future', 'closed'])
  })

  it('within the same state, sorts by id descending (newest first)', () => {
    const older = sprint({ id: 1, state: 'active' })
    const newer = sprint({ id: 5, state: 'active' })
    const middle = sprint({ id: 3, state: 'active' })
    const result = orderSprints([older, newer, middle])
    expect(result.map((s) => s.id)).toEqual([5, 3, 1])
  })
})

describe('matchesSprintFilter', () => {
  it('kind:id matches by exact sprint id', () => {
    const issue = jiraIssue({ sprints: [sprint({ id: 42 })] })
    expect(matchesSprintFilter(issue, { kind: 'id', id: 42, name: 'Sprint 1' })).toBe(true)
    expect(matchesSprintFilter(issue, { kind: 'id', id: 99, name: 'Other' })).toBe(false)
  })

  it('kind:name does a case-insensitive substring match', () => {
    const issue = jiraIssue({ sprints: [sprint({ name: 'TM_Q326_Sprint7' })] })
    expect(matchesSprintFilter(issue, { kind: 'name', text: 'q326' })).toBe(true)
    expect(matchesSprintFilter(issue, { kind: 'name', text: 'SPRINT7' })).toBe(true)
    expect(matchesSprintFilter(issue, { kind: 'name', text: 'nope' })).toBe(false)
  })

  it('an empty or whitespace-only free-text filter matches every issue', () => {
    const noSprints = jiraIssue({ sprints: [] })
    const withSprints = jiraIssue({ sprints: [sprint()] })
    expect(matchesSprintFilter(noSprints, { kind: 'name', text: '' })).toBe(true)
    expect(matchesSprintFilter(noSprints, { kind: 'name', text: '   ' })).toBe(true)
    expect(matchesSprintFilter(withSprints, { kind: 'name', text: '' })).toBe(true)
  })
})
