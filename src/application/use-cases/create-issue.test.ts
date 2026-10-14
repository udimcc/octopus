import { describe, it, expect } from 'vitest'
import { createIssue } from './create-issue'
import { makeDeps } from './test-fakes'
import { IssueStatus } from '../../domain/issue'

describe('createIssue ("Issues" §13.3)', () => {
  it('creates an unbound Todo issue by default', () => {
    const { deps, workspace, persistence, bus } = makeDeps()

    const result = createIssue(deps, { name: 'Fix the thing', description: 'details' })

    expect(result.ok).toBe(true)
    expect(result.issueId).toBeDefined()
    const issueId = result.issueId!

    expect(persistence.upsertedIssues.map((i) => i.id)).toEqual([issueId])
    expect(bus.ofType('issueUpserted').map((e) => e.issue.id)).toEqual([issueId])

    const issue = workspace.issue(issueId)
    expect(issue).toBeDefined()
    expect(issue!.name).toBe('Fix the thing')
    expect(issue!.description).toBe('details')
    expect(issue!.status).toBe(IssueStatus.Todo)
    expect(issue!.taskId).toBeUndefined()
    expect(issue!.projectPath).toBeUndefined()
  })

  it('throws on an empty/whitespace-only name, before persisting or touching the workspace', () => {
    const { deps, workspace, persistence } = makeDeps()

    expect(() => createIssue(deps, { name: '   ', description: 'x' })).toThrow()

    expect(persistence.upsertedIssues).toEqual([])
    expect(workspace.issues()).toEqual([])
  })

  it('rejects an unknown/unconfigured projectPath with { ok: false }, persisting nothing', () => {
    const { deps, workspace, persistence, settings } = makeDeps()
    settings.save({ projects: [{ path: '/configured' }] })

    const result = createIssue(deps, {
      name: 'An issue',
      description: '',
      projectPath: '/not-configured'
    })

    expect(result).toEqual({ ok: false, error: 'Unknown project: /not-configured' })
    expect(persistence.upsertedIssues).toEqual([])
    expect(workspace.issues()).toEqual([])
  })

  it('resolves and stores a valid, configured projectPath', () => {
    const { deps, workspace, settings } = makeDeps()
    settings.save({ projects: [{ path: '/configured' }] })

    const result = createIssue(deps, {
      name: 'An issue',
      description: '',
      projectPath: '/configured'
    })

    expect(result.ok).toBe(true)
    const issue = workspace.issue(result.issueId!)
    expect(issue!.projectPath).toBe('/configured')
  })

  it('honors an explicit status on the input instead of defaulting to Todo', () => {
    const { deps, workspace } = makeDeps()

    const result = createIssue(deps, {
      name: 'An issue',
      description: '',
      status: IssueStatus.InReview
    })

    expect(result.ok).toBe(true)
    const issue = workspace.issue(result.issueId!)
    expect(issue!.status).toBe(IssueStatus.InReview)
  })

  it('matches projectPath canonically (trailing slash) against a configured project', () => {
    const { deps, workspace, settings } = makeDeps()
    settings.save({ projects: [{ path: '/repo' }] })

    const result = createIssue(deps, { name: 'An issue', description: '', projectPath: '/repo/' })

    expect(result.ok).toBe(true)
    const issue = workspace.issue(result.issueId!)
    // Stored as the configured project's own spelling, not the input's.
    expect(issue!.projectPath).toBe('/repo')
  })

  it('persists before mutating in-memory: a persistence failure leaves the issue OUT of the workspace entirely', () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    persistence.upsertIssue = () => {
      throw new Error('disk full')
    }

    expect(() => createIssue(deps, { name: 'An issue', description: '' })).toThrow(/disk full/)

    expect(workspace.issues()).toEqual([])
    expect(bus.ofType('issueUpserted')).toEqual([])
  })
})
