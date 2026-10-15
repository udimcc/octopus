import { describe, it, expect } from 'vitest'
import { previewJiraIssues } from './preview-jira-issues'
import { makeDeps } from '../use-cases/test-fakes'
import { createIssue } from '../use-cases/create-issue'
import { importJiraIssues } from '../use-cases/import-jira-issues'
import type { JiraIssue } from '../../domain/jira-import'

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

describe('previewJiraIssues ("Jira import")', () => {
  it('classifies a fetched issue with no matching jiraKey in the workspace as new', () => {
    const { deps } = makeDeps()

    const [preview] = previewJiraIssues(deps, [jiraIssue({ key: 'PROJ-1' })])

    expect(preview.issue.key).toBe('PROJ-1')
    expect(preview.composed.name).toBe('PROJ-1: Fix the bug')
    expect(preview.classification).toEqual({ kind: 'new' })
  })

  it('classifies as duplicate once the issue has actually been imported', () => {
    const { deps } = makeDeps()
    const issue = jiraIssue({ key: 'PROJ-1', summary: 'Fix the bug' })
    importJiraIssues(deps, { issues: [issue] })

    const [preview] = previewJiraIssues(deps, [issue])

    expect(preview.classification.kind).toBe('duplicate')
  })

  it('classifies as conflict when the imported issue was renamed locally since', () => {
    const { deps, workspace } = makeDeps()
    const issue = jiraIssue({ key: 'PROJ-1', summary: 'Fix the bug' })
    importJiraIssues(deps, { issues: [issue] })
    const [imported] = workspace.issues()
    imported.rename('Renamed locally')

    const [preview] = previewJiraIssues(deps, [issue])

    expect(preview.classification.kind).toBe('conflict')
    if (preview.classification.kind !== 'new') {
      expect(preview.classification.issueId).toBe(imported.id)
    }
  })

  it('does not mutate the workspace or persistence — a pure read', () => {
    const { deps, workspace, persistence, bus } = makeDeps()

    previewJiraIssues(deps, [jiraIssue({ key: 'PROJ-1' }), jiraIssue({ key: 'PROJ-2' })])

    expect(workspace.issues()).toEqual([])
    expect(persistence.upsertedIssues).toEqual([])
    expect(bus.ofType('issueUpserted')).toEqual([])
  })

  it('previews each issue independently, in input order', () => {
    const { deps } = makeDeps()

    const previews = previewJiraIssues(deps, [
      jiraIssue({ key: 'PROJ-1', summary: 'First' }),
      jiraIssue({ key: 'PROJ-2', summary: 'Second' })
    ])

    expect(previews.map((p) => p.issue.key)).toEqual(['PROJ-1', 'PROJ-2'])
    expect(previews.every((p) => p.classification.kind === 'new')).toBe(true)
  })

  it('classifies against the workspace, independent of unrelated local issues', () => {
    const { deps } = makeDeps()
    createIssue(deps, { name: 'Unrelated local issue', description: '' })

    const [preview] = previewJiraIssues(deps, [jiraIssue({ key: 'PROJ-1' })])

    expect(preview.classification).toEqual({ kind: 'new' })
  })
})
