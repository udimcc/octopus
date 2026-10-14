import { describe, it, expect } from 'vitest'
import { removeProject } from './remove-project'
import { createTask } from './create-task'
import { createIssue } from './create-issue'
import { makeDeps, taskInput } from './test-fakes'

describe('removeProject (§5.4, §6.3)', () => {
  it('is blocked while a matching task exists (singular message)', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: false, error: 'Project has 1 task; delete it first' })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo' }])
  })

  it('is blocked while two tasks match (plural message)', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))
    await createTask(fd.deps, taskInput('b', { repoDir: '/repo' }))

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: false, error: 'Project has 2 tasks; delete them first' })
  })

  it('matches canonically — a trailing-slash project path still blocks on a task repoRoot without one', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo/' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    const res = removeProject(fd.deps, { path: '/repo/' })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/1 task; delete it first/)
  })

  it('canonicalizes the input path — removes a project stored without a trailing slash', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = removeProject(fd.deps, { path: '/repo/' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([])
  })

  it('is allowed when only repo-less tasks exist', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    await createTask(fd.deps, { mode: 'none', name: 'no-repo-task' })

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([])
  })

  it('is allowed when only another repo’s tasks exist', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo-a' }, { path: '/repo-b' }] })
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo-b' }))

    const res = removeProject(fd.deps, { path: '/repo-a' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo-b' }])
  })

  it('removing the last project leaves []', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/only' }] })

    const res = removeProject(fd.deps, { path: '/only' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([])
  })

  it('is an idempotent no-op success when projects was never seeded (undefined)', () => {
    const fd = makeDeps()
    expect(fd.settings.load().projects).toBeUndefined()

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toBeUndefined()
  })

  it('an unknown path is an idempotent no-op success', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })

    const res = removeProject(fd.deps, { path: '/unknown' })

    expect(res).toEqual({ ok: true })
    expect(fd.settings.load().projects).toEqual([{ path: '/repo' }])
  })
})

describe('removeProject issue cleanup (Issues §13.3, I19)', () => {
  it('succeeds and clears projectPath on issues referencing it, when no task matches', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    const issueId = createIssue(fd.deps, {
      name: 'Fix',
      description: '',
      projectPath: '/repo'
    }).issueId!

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res).toEqual({ ok: true })
    expect(fd.workspace.issue(issueId)!.projectPath).toBeUndefined()
    // The clear reached the DB, not just the in-memory `Workspace`.
    expect(fd.persistence.issues.get(issueId)?.projectPath).toBeUndefined()
    const events = fd.bus.ofType('issueUpserted')
    expect(events.at(-1)?.issue.id).toBe(issueId)
    expect(events.at(-1)?.issue.projectPath).toBeUndefined()
  })

  it('m5: canonicalizes the issue-side match too — removing "/repo/" clears an issue stored as "/repo"', () => {
    const fd = makeDeps()
    // Settings (and so the issue, which stores whatever `createIssue` matched it
    // to) hold the project WITHOUT a trailing slash.
    fd.settings.save({ projects: [{ path: '/repo' }] })
    const issueId = createIssue(fd.deps, {
      name: 'Fix',
      description: '',
      projectPath: '/repo'
    }).issueId!
    expect(fd.workspace.issue(issueId)!.projectPath).toBe('/repo')

    // Removed WITH a trailing slash — `affectedIssues`' own `canonProjectPath`
    // comparison (remove-project.ts) must still match the issue's "/repo".
    const res = removeProject(fd.deps, { path: '/repo/' })

    expect(res).toEqual({ ok: true })
    expect(fd.workspace.issue(issueId)!.projectPath).toBeUndefined()
    expect(fd.persistence.issues.get(issueId)?.projectPath).toBeUndefined()
  })

  it('still blocks when a TASK matches the project, leaving the issue on it untouched (whole call is a no-op)', async () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    const issueId = createIssue(fd.deps, {
      name: 'Fix',
      description: '',
      projectPath: '/repo'
    }).issueId!
    await createTask(fd.deps, taskInput('a', { repoDir: '/repo' }))

    const res = removeProject(fd.deps, { path: '/repo' })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/1 task; delete it first/)
    expect(fd.workspace.issue(issueId)!.projectPath).toBe('/repo')
    expect(fd.bus.ofType('issueUpserted').filter((e) => e.issue.id === issueId)).toHaveLength(1) // only the create's own upsert
  })

  it('leaves issues on a DIFFERENT, unrelated project completely untouched', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo-a' }, { path: '/repo-b' }] })
    const issueId = createIssue(fd.deps, {
      name: 'Fix',
      description: '',
      projectPath: '/repo-b'
    }).issueId!

    const res = removeProject(fd.deps, { path: '/repo-a' })

    expect(res).toEqual({ ok: true })
    expect(fd.workspace.issue(issueId)!.projectPath).toBe('/repo-b')
  })

  it('a settings.save failure re-upserts the ORIGINAL issue snapshots and leaves Workspace untouched', () => {
    const fd = makeDeps()
    fd.settings.save({ projects: [{ path: '/repo' }] })
    const issueId = createIssue(fd.deps, {
      name: 'Fix',
      description: '',
      projectPath: '/repo'
    }).issueId!
    const issueUpsertedBefore = fd.bus.ofType('issueUpserted').length
    fd.settings.save = () => {
      throw new Error('disk full')
    }

    expect(() => removeProject(fd.deps, { path: '/repo' })).toThrow(/disk full/)

    // The DB rolled back to the pre-clear snapshot...
    expect(fd.persistence.issues.get(issueId)?.projectPath).toBe('/repo')
    // ...and Workspace was never mutated in this path (the in-memory clear only
    // runs after settings.save succeeds).
    expect(fd.workspace.issue(issueId)!.projectPath).toBe('/repo')
    // The two writes made for THIS call, in order: the clear, then the
    // re-upserted original (the `catch`'s rollback transaction) — confirms the
    // rollback actually re-wrote the row rather than merely leaving it alone.
    const tail = fd.persistence.upsertedIssues.slice(-2)
    expect(tail.map((s) => s.projectPath)).toEqual([undefined, '/repo'])
    // No issueUpserted was published for this call — `removeProject` only
    // publishes AFTER `settings.save` succeeds, which never happened here. Only
    // createIssue's own event (from before this call) exists.
    expect(fd.bus.ofType('issueUpserted')).toHaveLength(issueUpsertedBefore)
  })
})
