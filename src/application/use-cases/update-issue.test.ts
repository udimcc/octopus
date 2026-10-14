import { describe, it, expect } from 'vitest'
import { createIssue } from './create-issue'
import { updateIssue } from './update-issue'
import { makeDeps } from './test-fakes'
import { IssueStatus } from '../../domain/issue'
import { asIssueId } from '../../domain/ids'

describe('updateIssue ("Issues" §13)', () => {
  it('patches fields independently — fields not present on the input are left unchanged', () => {
    const { deps, workspace, persistence, bus } = makeDeps()
    const { issueId } = createIssue(deps, { name: 'Orig', description: 'orig desc' })
    const id = issueId!

    const r1 = updateIssue(deps, { issueId: id, name: 'Renamed' })
    expect(r1).toEqual({ ok: true })
    let issue = workspace.issue(id)!
    expect(issue.name).toBe('Renamed')
    expect(issue.description).toBe('orig desc')
    expect(issue.status).toBe(IssueStatus.Todo)
    // The persisted record and the last-published event mirror in-memory state.
    expect(persistence.issues.get(id)).toMatchObject({
      name: 'Renamed',
      description: 'orig desc',
      status: IssueStatus.Todo
    })
    expect(bus.ofType('issueUpserted').at(-1)?.issue).toMatchObject({
      id,
      name: 'Renamed',
      description: 'orig desc',
      status: IssueStatus.Todo
    })

    const r2 = updateIssue(deps, { issueId: id, description: 'new desc' })
    expect(r2).toEqual({ ok: true })
    issue = workspace.issue(id)!
    expect(issue.name).toBe('Renamed')
    expect(issue.description).toBe('new desc')
    expect(issue.status).toBe(IssueStatus.Todo)
    expect(persistence.issues.get(id)).toMatchObject({
      name: 'Renamed',
      description: 'new desc',
      status: IssueStatus.Todo
    })
    expect(bus.ofType('issueUpserted').at(-1)?.issue).toMatchObject({
      id,
      name: 'Renamed',
      description: 'new desc',
      status: IssueStatus.Todo
    })

    const r3 = updateIssue(deps, { issueId: id, status: IssueStatus.InReview })
    expect(r3).toEqual({ ok: true })
    issue = workspace.issue(id)!
    expect(issue.name).toBe('Renamed')
    expect(issue.description).toBe('new desc')
    expect(issue.status).toBe(IssueStatus.InReview)
    expect(persistence.issues.get(id)).toMatchObject({
      name: 'Renamed',
      description: 'new desc',
      status: IssueStatus.InReview
    })
    expect(bus.ofType('issueUpserted').at(-1)?.issue).toMatchObject({
      id,
      status: IssueStatus.InReview
    })
  })

  it('projectPath: null explicitly clears the project; omitted leaves it as-is', () => {
    const { deps, workspace, persistence, bus, settings } = makeDeps()
    settings.save({ projects: [{ path: '/configured' }] })
    const { issueId } = createIssue(deps, {
      name: 'Orig',
      description: '',
      projectPath: '/configured'
    })
    const id = issueId!

    // Omitted projectPath leaves it as-is.
    updateIssue(deps, { issueId: id, name: 'Still has project' })
    expect(workspace.issue(id)!.projectPath).toBe('/configured')
    expect(persistence.issues.get(id)?.projectPath).toBe('/configured')

    // Explicit null clears it.
    const r = updateIssue(deps, { issueId: id, projectPath: null })
    expect(r).toEqual({ ok: true })
    expect(workspace.issue(id)!.projectPath).toBeUndefined()
    // The persisted record and the published event both carry the clear through —
    // not just the in-memory `Issue`.
    expect(persistence.issues.get(id)?.projectPath).toBeUndefined()
    expect(bus.ofType('issueUpserted').at(-1)?.issue.projectPath).toBeUndefined()
  })

  it('rejects a provided-but-unknown projectPath BEFORE any mutation', () => {
    const { deps, workspace, persistence, settings } = makeDeps()
    settings.save({ projects: [{ path: '/configured' }] })
    const { issueId } = createIssue(deps, {
      name: 'Orig',
      description: 'orig desc',
      projectPath: '/configured',
      status: IssueStatus.InProgress
    })
    const id = issueId!
    const before = workspace.issue(id)!.toSnapshot()
    const upsertCountBefore = persistence.upsertedIssues.length

    const result = updateIssue(deps, {
      issueId: id,
      name: 'New name',
      description: 'new desc',
      status: IssueStatus.Done,
      projectPath: '/unknown'
    })

    expect(result).toEqual({ ok: false, error: 'Unknown project: /unknown' })
    const after = workspace.issue(id)!
    expect(after.name).toBe(before.name)
    expect(after.description).toBe(before.description)
    expect(after.projectPath).toBe(before.projectPath)
    expect(after.status).toBe(before.status)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(persistence.upsertedIssues).toHaveLength(upsertCountBefore)
  })

  it('rejects an empty/whitespace name patch, never reaching upsertIssue nor touching other fields', () => {
    const { deps, workspace, persistence, settings } = makeDeps()
    settings.save({ projects: [{ path: '/configured' }] })
    const { issueId } = createIssue(deps, {
      name: 'Orig',
      description: 'orig desc',
      projectPath: '/configured',
      status: IssueStatus.InProgress
    })
    const id = issueId!
    const upsertCountBefore = persistence.upsertedIssues.length

    expect(() =>
      updateIssue(deps, {
        issueId: id,
        name: '   ',
        description: 'new desc',
        projectPath: null,
        status: IssueStatus.Done
      })
    ).toThrow()

    const after = workspace.issue(id)!
    expect(after.name).toBe('Orig')
    expect(after.description).toBe('orig desc')
    expect(after.projectPath).toBe('/configured')
    expect(after.status).toBe(IssueStatus.InProgress)
    expect(persistence.upsertedIssues).toHaveLength(upsertCountBefore)
  })

  it('touch()es updatedAt to the current clock time on a successful update', () => {
    const { deps, workspace, persistence, bus, clock } = makeDeps()
    const { issueId } = createIssue(deps, { name: 'Orig', description: '' })
    const id = issueId!
    const createdAt = workspace.issue(id)!.updatedAt

    clock.t = createdAt + 5_000
    updateIssue(deps, { issueId: id, name: 'Changed' })

    expect(workspace.issue(id)!.updatedAt).toBe(createdAt + 5_000)
    // The new updatedAt reaches both the persisted record and the published event.
    expect(persistence.issues.get(id)?.updatedAt).toBe(createdAt + 5_000)
    expect(bus.ofType('issueUpserted').at(-1)?.issue.updatedAt).toBe(createdAt + 5_000)
  })

  it('restores all fields to their pre-call values if upsertIssue throws, and rethrows', () => {
    const { deps, workspace, persistence, bus, settings, clock } = makeDeps()
    settings.save({ projects: [{ path: '/configured' }, { path: '/other' }] })
    const { issueId } = createIssue(deps, {
      name: 'Orig',
      description: 'orig desc',
      projectPath: '/configured',
      status: IssueStatus.InProgress
    })
    const id = issueId!
    const before = workspace.issue(id)!.toSnapshot()
    const issueUpsertedBefore = bus.ofType('issueUpserted').length

    clock.t = before.updatedAt + 1_000
    const diskError = new Error('disk full')
    persistence.upsertIssue = () => {
      throw diskError
    }

    expect(() =>
      updateIssue(deps, {
        issueId: id,
        name: 'New name',
        description: 'new desc',
        projectPath: '/other',
        status: IssueStatus.Done
      })
    ).toThrow(diskError)

    const after = workspace.issue(id)!
    expect(after.name).toBe(before.name)
    expect(after.description).toBe(before.description)
    expect(after.projectPath).toBe(before.projectPath)
    expect(after.status).toBe(before.status)
    expect(after.updatedAt).toBe(before.updatedAt)
    // No issueUpserted was published for the failed attempt (only createIssue's own,
    // from before this call).
    expect(bus.ofType('issueUpserted')).toHaveLength(issueUpsertedBefore)
  })

  it('returns { ok: false } for a non-existent issueId', () => {
    const { deps } = makeDeps()

    const result = updateIssue(deps, { issueId: asIssueId('ghost'), name: 'x' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })
})
