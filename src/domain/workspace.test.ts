import { describe, it, expect } from 'vitest'
import { Workspace } from './workspace'
import { Task } from './task'
import { asTaskId, asIssueId } from './ids'
import { InvariantViolationError } from './errors'
import { worstStatusWins } from './task-state-aggregator'
import { Issue, IssueSource, IssueStatus } from './issue'
import type { WorkspaceSnapshot } from './snapshots'

const config = { defaultSessionTypeId: 'terminal' }

function task(id: string, position: number): Task {
  return Task.create({ id: asTaskId(id), name: id, position, createdAt: 1 })
}

function issue(id: string, over: Partial<Parameters<typeof Issue.create>[0]> = {}): Issue {
  return Issue.create({ id: asIssueId(id), name: id, description: '', createdAt: 1, ...over })
}

describe('Workspace (§3.2, I6/I9)', () => {
  it('adds tasks and rejects duplicate ids (I6)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    expect(() => ws.addTask(task('t1', 1))).toThrow(InvariantViolationError)
  })

  it('keeps at most one active task and validates the pointer (I9)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.setActiveTask(asTaskId('t2'))
    expect(ws.activeTaskId).toBe(asTaskId('t2'))
    expect(() => ws.setActiveTask(asTaskId('ghost'))).toThrow(InvariantViolationError)
  })

  it('clears the active pointer when the active task is removed (I9)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.setActiveTask(asTaskId('t1'))
    ws.removeTask(asTaskId('t1'))
    expect(ws.activeTaskId).toBeUndefined()
  })

  it('reorders tasks and renumbers position densely', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.addTask(task('t3', 2))
    ws.reorderTask(asTaskId('t3'), 0)
    expect(ws.tasks().map((t) => t.id)).toEqual([asTaskId('t3'), asTaskId('t1'), asTaskId('t2')])
    expect(ws.tasks().map((t) => t.position)).toEqual([0, 1, 2])
  })

  it('hydrates from a snapshot, restoring order and a valid active pointer (I15)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.setActiveTask(asTaskId('t1'))
    const snap = ws.toSnapshot(worstStatusWins)
    const restored = Workspace.hydrate(snap, config)
    expect(restored.tasks().map((t) => t.id)).toEqual([asTaskId('t1'), asTaskId('t2')])
    expect(restored.activeTaskId).toBe(asTaskId('t1'))
  })

  it('drops a dangling active-task pointer on hydrate (I9)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    const snap = ws.toSnapshot(worstStatusWins)
    const tampered = { ...snap, activeTaskId: asTaskId('ghost') }
    const restored = Workspace.hydrate(tampered, config)
    expect(restored.activeTaskId).toBeUndefined()
  })

  it('merges config patches without dropping other keys', () => {
    const ws = Workspace.create(config)
    ws.updateConfig({ defaultSessionTypeId: 'jenkins' })
    expect(ws.config.defaultSessionTypeId).toBe('jenkins')
  })
})

describe('Workspace — issues (I19)', () => {
  it('adds issues and rejects duplicate ids (I6)', () => {
    const ws = Workspace.create(config)
    ws.addIssue(issue('i1'))
    expect(() => ws.addIssue(issue('i1'))).toThrow(InvariantViolationError)
  })

  it('addIssue + issue()/issues() basic bookkeeping', () => {
    const ws = Workspace.create(config)
    const i1 = issue('i1')
    const i2 = issue('i2')
    ws.addIssue(i1)
    ws.addIssue(i2)
    expect(ws.issue(asIssueId('i1'))).toBe(i1)
    expect(ws.issue(asIssueId('i2'))).toBe(i2)
    expect(ws.issues().map((i) => i.id)).toEqual([asIssueId('i1'), asIssueId('i2')])
  })

  it('removeIssue drops the issue; a no-op for an unknown id', () => {
    const ws = Workspace.create(config)
    ws.addIssue(issue('i1'))
    ws.removeIssue(asIssueId('i1'))
    expect(ws.issue(asIssueId('i1'))).toBeUndefined()
    expect(() => ws.removeIssue(asIssueId('ghost'))).not.toThrow()
  })

  it('bindIssue throws when the issue does not exist', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    expect(() => ws.bindIssue(asIssueId('ghost'), asTaskId('t1'))).toThrow(InvariantViolationError)
  })

  it('bindIssue throws when the task does not exist', () => {
    const ws = Workspace.create(config)
    ws.addIssue(issue('i1'))
    expect(() => ws.bindIssue(asIssueId('i1'), asTaskId('ghost'))).toThrow(InvariantViolationError)
  })

  it('bindIssue throws when the task is already bound to a different issue, leaving both bindings unchanged', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.addIssue(issue('i2'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    expect(() => ws.bindIssue(asIssueId('i2'), asTaskId('t1'))).toThrow(InvariantViolationError)
    expect(ws.issueForTask(asTaskId('t1'))!.id).toBe(asIssueId('i1'))
    expect(ws.issue(asIssueId('i1'))!.taskId).toBe(asTaskId('t1'))
    expect(ws.issue(asIssueId('i2'))!.taskId).toBeUndefined()
  })

  it("rejects binding a task already linked to another issue, from the new issue's perspective (I19)", () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    const issueA = issue('iA')
    const issueB = issue('iB')
    ws.addIssue(issueA)
    ws.addIssue(issueB)
    ws.bindIssue(asIssueId('iA'), asTaskId('t1'))
    expect(() => ws.bindIssue(asIssueId('iB'), asTaskId('t1'))).toThrow(InvariantViolationError)
    expect(ws.issueForTask(asTaskId('t1'))!.id).toBe(asIssueId('iA'))
  })

  it('bindIssue to the task it is already bound to is a true no-op once already InProgress', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.InProgress)
    // Re-binding to the same task again: taskId unchanged, status stays InProgress.
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    expect(ws.issue(asIssueId('i1'))!.taskId).toBe(asTaskId('t1'))
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.InProgress)
  })

  it('rebinding an issue to a new task frees the old task for another issue', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.addIssue(issue('i1'))
    ws.addIssue(issue('i2'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t2'))
    expect(ws.issue(asIssueId('i1'))!.taskId).toBe(asTaskId('t2'))
    // t1 is now free: issueForTask resolves to nothing, and i2 can bind to it without throwing.
    expect(ws.issueForTask(asTaskId('t1'))).toBeUndefined()
    expect(() => ws.bindIssue(asIssueId('i2'), asTaskId('t1'))).not.toThrow()
    expect(ws.issue(asIssueId('i2'))!.taskId).toBe(asTaskId('t1'))
  })

  it('bindIssue flips Todo -> InProgress, but only from Todo', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addTask(task('t2', 1))
    ws.addIssue(issue('i1'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.InProgress)

    const inReview = issue('i2')
    inReview.setStatus(IssueStatus.InReview)
    ws.addIssue(inReview)
    ws.bindIssue(asIssueId('i2'), asTaskId('t2'))
    expect(ws.issue(asIssueId('i2'))!.status).toBe(IssueStatus.InReview)
  })

  it('bindIssue does not flip a Done issue', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    const done = issue('i1')
    done.setStatus(IssueStatus.Done)
    ws.addIssue(done)
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.Done)
  })

  it('unbindIssue clears taskId and leaves status unchanged', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    ws.unbindIssue(asIssueId('i1'))
    expect(ws.issue(asIssueId('i1'))!.taskId).toBeUndefined()
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.InProgress)
  })

  it('unbindIssue is a no-op for an unknown or never-bound issue', () => {
    const ws = Workspace.create(config)
    ws.addIssue(issue('i1'))
    expect(() => ws.unbindIssue(asIssueId('ghost'))).not.toThrow()
    expect(() => ws.unbindIssue(asIssueId('i1'))).not.toThrow()
  })

  it('restoreIssueBinding bypasses the 1:1 check', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.addIssue(issue('i2'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    // i2 "restoring" to t1 would be rejected by bindIssue, but restoreIssueBinding
    // bypasses the check entirely (used only to undo an in-memory mutation).
    expect(() =>
      ws.restoreIssueBinding(asIssueId('i2'), asTaskId('t1'), IssueStatus.Todo)
    ).not.toThrow()
    expect(ws.issue(asIssueId('i2'))!.taskId).toBe(asTaskId('t1'))
  })

  it('restoreIssueBinding bypasses the todo->in_progress automation', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.restoreIssueBinding(asIssueId('i1'), asTaskId('t1'), IssueStatus.Todo)
    expect(ws.issue(asIssueId('i1'))!.taskId).toBe(asTaskId('t1'))
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.Todo)
  })

  it('restoreIssueBinding with priorTaskId undefined clears the binding', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    ws.restoreIssueBinding(asIssueId('i1'), undefined, IssueStatus.Todo)
    expect(ws.issue(asIssueId('i1'))!.taskId).toBeUndefined()
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.Todo)
  })

  it('restoreIssueBinding is a no-op for an unknown issue', () => {
    const ws = Workspace.create(config)
    expect(() =>
      ws.restoreIssueBinding(asIssueId('ghost'), asTaskId('t1'), IssueStatus.Todo)
    ).not.toThrow()
  })

  it('restoreIssueBinding is a no-op when the issue was already removed from the workspace', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.removeIssue(asIssueId('i1'))
    expect(() =>
      ws.restoreIssueBinding(asIssueId('i1'), asTaskId('t1'), IssueStatus.InProgress)
    ).not.toThrow()
    expect(ws.issue(asIssueId('i1'))).toBeUndefined()
  })

  it("removeTask clears the bound issue's binding, leaving its status unchanged (I19)", () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    ws.removeTask(asTaskId('t1'))
    expect(ws.issue(asIssueId('i1'))!.taskId).toBeUndefined()
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.InProgress)
    // The issue itself is not removed, only unbound.
    expect(ws.issues().map((i) => i.id)).toEqual([asIssueId('i1')])
  })

  it('removeTask is a no-op (no throw) when the task had no bound issue', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    expect(() => ws.removeTask(asTaskId('t1'))).not.toThrow()
    expect(ws.issue(asIssueId('i1'))!.taskId).toBeUndefined()
    expect(ws.issue(asIssueId('i1'))!.status).toBe(IssueStatus.Todo)
  })

  it('clearIssueProject clears only issues whose project canonically matches', () => {
    const ws = Workspace.create(config)
    const matching = issue('i1', { projectPath: '/repo/main/' })
    const different = issue('i2', { projectPath: '/repo/other' })
    const none = issue('i3')
    ws.addIssue(matching)
    ws.addIssue(different)
    ws.addIssue(none)

    const changed = ws.clearIssueProject('/repo//main')
    expect(changed.map((i) => i.id)).toEqual([asIssueId('i1')])
    expect(ws.issue(asIssueId('i1'))!.projectPath).toBeUndefined()
    expect(ws.issue(asIssueId('i2'))!.projectPath).toBe('/repo/other')
    expect(ws.issue(asIssueId('i3'))!.projectPath).toBeUndefined()
  })

  it('hydrate tolerates a snapshot with no issues field (pre-Issues fixture)', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    const snap = ws.toSnapshot(worstStatusWins)
    const { issues, ...withoutIssues } = snap
    void issues
    const restored = Workspace.hydrate(withoutIssues, config)
    expect(restored.issues()).toEqual([])
  })

  it('hydrate drops a binding to a task missing from the snapshot, keeps one that resolves', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    const i2 = issue('i2')
    i2.setStatus(IssueStatus.InReview)
    ws.addIssue(i2)
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    const snap = ws.toSnapshot(worstStatusWins)
    const tampered = {
      ...snap,
      issues: snap.issues!.map((i) =>
        i.id === asIssueId('i2') ? { ...i, taskId: asTaskId('ghost') } : i
      )
    }
    const restored = Workspace.hydrate(tampered, config)
    expect(restored.issue(asIssueId('i1'))!.taskId).toBe(asTaskId('t1'))
    // The dangling binding is dropped, but hydrate never touches status — the
    // persisted InReview status (unrelated to the binding) survives untouched.
    expect(restored.issue(asIssueId('i2'))!.status).toBe(IssueStatus.InReview)
    expect(restored.issue(asIssueId('i2'))!.taskId).toBeUndefined()
  })

  it('a newly created issue added to the workspace defaults to source=local', () => {
    const ws = Workspace.create(config)
    ws.addIssue(issue('i1'))
    expect(ws.issue(asIssueId('i1'))!.source).toBe(IssueSource.Local)
    expect(ws.issue(asIssueId('i1'))!.jiraKey).toBeUndefined()
  })

  it('hydrate defaults a pre-Jira-import issue snapshot (no source) to source=local', () => {
    const ws = Workspace.create(config)
    ws.addIssue(issue('i1'))
    const snap = ws.toSnapshot(worstStatusWins)
    const { source, ...withoutSource } = snap.issues![0]
    void source
    // Pre-Jira-import fixtures never wrote a `source` column; simulate that shape here —
    // `IssueSnapshot.source` is required going forward, so this needs a cast.
    const tampered = { ...snap, issues: [withoutSource] } as unknown as WorkspaceSnapshot
    const restored = Workspace.hydrate(tampered, config)
    expect(restored.issue(asIssueId('i1'))!.source).toBe(IssueSource.Local)
    expect(restored.issue(asIssueId('i1'))!.jiraKey).toBeUndefined()
  })

  it('toSnapshot includes bound issues', () => {
    const ws = Workspace.create(config)
    ws.addTask(task('t1', 0))
    ws.addIssue(issue('i1'))
    ws.bindIssue(asIssueId('i1'), asTaskId('t1'))
    const snap = ws.toSnapshot(worstStatusWins)
    expect(snap.issues).toHaveLength(1)
    expect(snap.issues![0].id).toBe(asIssueId('i1'))
    expect(snap.issues![0].taskId).toBe(asTaskId('t1'))
    expect(snap.issues![0].status).toBe(IssueStatus.InProgress)
  })
})
