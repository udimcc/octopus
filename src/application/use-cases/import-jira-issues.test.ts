import { describe, it, expect } from 'vitest'
import { importJiraIssues } from './import-jira-issues'
import { makeDeps } from './test-fakes'
import { IssueSource, IssueStatus } from '../../domain/issue'
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

describe('importJiraIssues ("Jira import")', () => {
  it('creates a local Jira-sourced issue for each new fetched issue', () => {
    const { deps, workspace, persistence, bus } = makeDeps()

    const result = importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })

    expect(result).toMatchObject({ ok: true, importedCount: 1, skippedKeys: [] })
    const [issue] = workspace.issues()
    expect(issue.name).toBe('PROJ-1: Fix the bug')
    expect(issue.source).toBe(IssueSource.Jira)
    expect(issue.jiraKey).toBe('PROJ-1')
    expect(issue.projectPath).toBeUndefined()
    expect(persistence.upsertedIssues.map((i) => i.id)).toEqual([issue.id])
    expect(bus.ofType('issueUpserted').map((e) => e.issue.id)).toEqual([issue.id])
  })

  it('skips an issue that already exists (classifies as duplicate or conflict)', () => {
    const { deps, workspace } = makeDeps()
    importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })

    const result = importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })

    expect(result).toMatchObject({ ok: true, importedCount: 0, skippedKeys: ['PROJ-1'] })
    expect(workspace.issues()).toHaveLength(1)
  })

  it('re-import of an imported issue that is now Blocked with reasons is skipped as unchanged and keeps its data', () => {
    const { deps, workspace } = makeDeps()
    importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })
    const [imported] = workspace.issues()
    imported.setBlockedReasons('waiting on infra')
    imported.setStatus(IssueStatus.Blocked)

    const result = importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })

    expect(result).toMatchObject({ ok: true, importedCount: 0, skippedKeys: ['PROJ-1'] })
    expect(workspace.issues()).toHaveLength(1)
    expect(workspace.issues()[0].status).toBe(IssueStatus.Blocked)
    expect(workspace.issues()[0].blockedReasons).toBe('waiting on infra')
  })

  it('re-classifies against the CURRENT workspace, not a stale snapshot the caller might pass stale data for', () => {
    const { deps, workspace } = makeDeps()
    importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })
    const [imported] = workspace.issues()
    imported.rename('Renamed locally since import')

    // A re-fetch of the same Jira issue now conflicts (name differs from what's stored).
    const result = importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })

    expect(result).toMatchObject({ ok: true, importedCount: 0, skippedKeys: ['PROJ-1'] })
    expect(workspace.issues()).toHaveLength(1)
  })

  it('imports several new issues in one batch, importing each exactly once', () => {
    const { deps, workspace, bus } = makeDeps()

    const result = importJiraIssues(deps, {
      issues: [jiraIssue({ key: 'PROJ-1' }), jiraIssue({ key: 'PROJ-2', summary: 'Second' })]
    })

    expect(result).toMatchObject({ ok: true, importedCount: 2, skippedKeys: [] })
    expect(workspace.issues().map((i) => i.jiraKey)).toEqual(['PROJ-1', 'PROJ-2'])
    for (const issue of workspace.issues()) {
      expect(issue.status).toBe(IssueStatus.Todo)
    }
    const upsertEvents = bus.ofType('issueUpserted')
    expect(upsertEvents).toHaveLength(2)
    expect(upsertEvents.map((e) => e.issue.id)).toEqual(workspace.issues().map((i) => i.id))
  })

  it('rolls back a mid-batch persistence failure: nothing committed, no events, one transaction attempted', () => {
    const { deps, workspace, bus, persistence } = makeDeps()
    persistence.failUpsertIssueAt = 2

    expect(() =>
      importJiraIssues(deps, {
        issues: [
          jiraIssue({ key: 'PROJ-1' }),
          jiraIssue({ key: 'PROJ-2', summary: 'Second' }),
          jiraIssue({ key: 'PROJ-3', summary: 'Third' })
        ]
      })
    ).toThrow()

    expect(workspace.issues()).toEqual([])
    expect(bus.ofType('issueUpserted')).toEqual([])
    expect(persistence.upsertedIssues).toEqual([])
    expect(persistence.issues.size).toBe(0)
    expect(persistence.transactions).toBe(1)
  })

  it('skips a key repeated within the SAME batch, keeping only the first occurrence', () => {
    const { deps, workspace } = makeDeps()

    const result = importJiraIssues(deps, {
      issues: [
        jiraIssue({ key: 'PROJ-1', summary: 'First' }),
        jiraIssue({ key: 'PROJ-1', summary: 'Second' })
      ]
    })

    expect(result).toMatchObject({ ok: true, importedCount: 1, skippedKeys: ['PROJ-1'] })
    expect(workspace.issues()).toHaveLength(1)
    expect(workspace.issues()[0].name).toBe('PROJ-1: First')
  })

  it('persists before mutating in-memory: a persistence failure leaves the workspace untouched', () => {
    const { deps, workspace, bus, persistence } = makeDeps()
    persistence.failUpsertIssueAt = 1

    expect(() => importJiraIssues(deps, { issues: [jiraIssue({ key: 'PROJ-1' })] })).toThrow()

    expect(workspace.issues()).toEqual([])
    expect(bus.ofType('issueUpserted')).toEqual([])
  })

  it('an empty issues array imports nothing and reports zero of both', () => {
    const { deps, workspace } = makeDeps()

    const result = importJiraIssues(deps, { issues: [] })

    expect(result).toEqual({ ok: true, importedCount: 0, skippedKeys: [] })
    expect(workspace.issues()).toEqual([])
  })
})
