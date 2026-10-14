import { describe, it, expect } from 'vitest'
import { Task, GROUP_COLOR_PALETTE_SIZE } from './task'
import { Session } from './session'
import { WorktreeRef } from './worktree-ref'
import { asTaskId, asSessionId, asTypeId, asWindowId, asGroupId, type WindowId } from './ids'
import { TaskLifecycle, SessionLifecycle } from './lifecycle'
import { TaskState, SessionState } from './state'
import { worstStatusWins } from './task-state-aggregator'
import { IllegalTransitionError, InvariantViolationError } from './errors'
import type { TaskSnapshot, SessionSnapshot, GroupSnapshot } from './snapshots'

const T1 = asTaskId('t1')
const TERMINAL = asTypeId('terminal')
const WIN_B = asWindowId('win-b')

function newTask(): Task {
  return Task.create({ id: T1, name: 'task', position: 0, createdAt: 1 })
}

function newSession(id: string, taskId = T1, order = 0): Session {
  return Session.create({
    id: asSessionId(id),
    taskId,
    typeId: TERMINAL,
    title: id,
    config: { kind: 'terminal' },
    order,
    createdAt: 1
  })
}

/** A task with `n` lone sessions, s1..sN, in order, all in the main window. */
function taskWithSessions(n: number): Task {
  const t = newTask()
  for (let i = 1; i <= n; i++) {
    t.addSession(newSession(`s${i}`, T1, i - 1))
  }
  return t
}

function sid(id: string) {
  return asSessionId(id)
}

/** A raw `SessionSnapshot` for building a `TaskSnapshot` directly (fromSnapshot tests). */
function sessionSnap(id: string, order: number, windowId?: WindowId): SessionSnapshot {
  return {
    id: sid(id),
    taskId: T1,
    typeId: TERMINAL,
    title: id,
    config: { kind: 'terminal' },
    lifecycle: SessionLifecycle.Created,
    state: SessionState.Unknown,
    order,
    createdAt: 1,
    windowId
  }
}

/** A raw `TaskSnapshot` with the given sessions and saved groups. */
function taskSnapWithGroups(
  sessions: readonly SessionSnapshot[],
  groups: readonly GroupSnapshot[]
): TaskSnapshot {
  return {
    id: T1,
    name: 'task',
    lifecycle: TaskLifecycle.Ready,
    state: TaskState.Unknown,
    sessions,
    position: 0,
    createdAt: 1,
    groups
  }
}

describe('Task lifecycle (§3.5)', () => {
  it('drives None → Provisioning → Ready with a worktree (I1)', () => {
    const t = newTask()
    expect(t.lifecycle).toBe(TaskLifecycle.None)
    t.markProvisioning()
    const wt = WorktreeRef.create({
      path: '/wt',
      managed: true,
      provisionedBy: { script: 's', args: [], repoRoot: '/r', provisionedAt: 1 }
    })
    t.markReady(wt)
    expect(t.lifecycle).toBe(TaskLifecycle.Ready)
    expect(t.worktree).toBe(wt)
  })

  it('throws on an illegal transition', () => {
    const t = newTask()
    expect(() => t.markReady(undefined as never)).toThrow(IllegalTransitionError)
  })

  it('drives None → Provisioning → Ready with NO worktree for a "No Repo" task (I1\', §5.4)', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReadyNoRepo()
    expect(t.lifecycle).toBe(TaskLifecycle.Ready)
    expect(t.worktree).toBeUndefined()
    expect(t.repoLess).toBe(true)
  })
})

describe('Task sessions (§3.2)', () => {
  it('rejects a session whose taskId does not match (I7)', () => {
    const t = newTask()
    const foreign = newSession('s1', asTaskId('other'))
    expect(() => t.addSession(foreign)).toThrow(InvariantViolationError)
  })

  it('makes the first added session active by default', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(t.activeSessionId).toBe(asSessionId('s1'))
  })

  it('rejects duplicate session ids', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(() => t.addSession(newSession('s1'))).toThrow(InvariantViolationError)
  })

  it('reassigns the active session when the active one is removed (I10)', () => {
    const t = newTask()
    t.addSession(newSession('s1', T1, 0))
    t.addSession(newSession('s2', T1, 1))
    expect(t.activeSessionId).toBe(asSessionId('s1'))
    t.removeSession(asSessionId('s1'))
    expect(t.activeSessionId).toBe(asSessionId('s2'))
  })

  it('clears the active session when the last one is removed', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    t.removeSession(asSessionId('s1'))
    expect(t.activeSessionId).toBeUndefined()
  })

  it('rejects setActiveSession for a session not in the task (I10)', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(() => t.setActiveSession(asSessionId('ghost'))).toThrow(InvariantViolationError)
  })

  it('reorders sessions and renumbers order densely', () => {
    const t = newTask()
    t.addSession(newSession('s1', T1, 0))
    t.addSession(newSession('s2', T1, 1))
    t.addSession(newSession('s3', T1, 2))
    t.reorderSession(asSessionId('s3'), 0)
    expect(t.sessions().map((s) => s.id)).toEqual([
      asSessionId('s3'),
      asSessionId('s1'),
      asSessionId('s2')
    ])
    expect(t.sessions().map((s) => s.order)).toEqual([0, 1, 2])
  })
})

describe('Task derived state (§3.4, I11)', () => {
  it('is Unknown for a task with only live V1 sessions', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    expect(t.deriveState(worstStatusWins)).toBe(TaskState.Unknown)
  })

  it('becomes Blocked when a session has Exited (I12)', () => {
    const t = newTask()
    const s = newSession('s1')
    t.addSession(s)
    s.markStarting()
    s.markRunning()
    s.markExited(2)
    expect(s.lifecycle).toBe(SessionLifecycle.Exited)
    expect(t.deriveState(worstStatusWins)).toBe(TaskState.NeedsInput)
  })
})

describe('Task snapshot round-trip (I15)', () => {
  it('reconstructs an equivalent task from its snapshot', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReady(
      WorktreeRef.create({
        path: '/wt',
        branch: 'b',
        managed: true,
        provisionedBy: { script: 's', args: ['x'], repoRoot: '/r', provisionedAt: 9 }
      })
    )
    t.addSession(newSession('s1', T1, 0))
    t.addSession(newSession('s2', T1, 1))
    const snap = t.toSnapshot(worstStatusWins)
    const restored = Task.fromSnapshot(snap)
    expect(restored.id).toBe(t.id)
    expect(restored.lifecycle).toBe(TaskLifecycle.Ready)
    expect(restored.worktree?.path).toBe('/wt')
    expect(restored.sessions().map((s) => s.id)).toEqual([asSessionId('s1'), asSessionId('s2')])
    expect(restored.activeSessionId).toBe(asSessionId('s1'))
  })

  it('round-trips a "No Repo" task: repoLess Ready with no worktree (§5.4)', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReadyNoRepo()
    t.addSession(newSession('s1', T1, 0))
    const snap = t.toSnapshot(worstStatusWins)
    expect(snap.repoLess).toBe(true)
    expect(snap.worktree).toBeUndefined()
    const restored = Task.fromSnapshot(snap)
    expect(restored.lifecycle).toBe(TaskLifecycle.Ready)
    expect(restored.repoLess).toBe(true)
    expect(restored.worktree).toBeUndefined()
    expect(restored.sessions().map((s) => s.id)).toEqual([asSessionId('s1')])
  })

  it('defaults repoLess to false when a snapshot omits it (pre-feature rows)', () => {
    const t = newTask()
    t.markProvisioning()
    t.markReady(
      WorktreeRef.create({
        path: '/wt',
        managed: true,
        provisionedBy: { script: 's', args: [], repoRoot: '/r', provisionedAt: 1 }
      })
    )
    const snap = t.toSnapshot(worstStatusWins)
    const { repoLess: _omit, ...withoutRepoLess } = snap
    void _omit
    const restored = Task.fromSnapshot(withoutRepoLess)
    expect(restored.repoLess).toBe(false)
  })

  it('drops a dangling active-session pointer on rehydrate (I10)', () => {
    const t = newTask()
    t.addSession(newSession('s1'))
    const snap = t.toSnapshot(worstStatusWins)
    const tampered = { ...snap, activeSessionId: asSessionId('ghost') }
    const restored = Task.fromSnapshot(tampered)
    expect(restored.activeSessionId).toBeUndefined()
  })
})

describe('Task split groups — join (§5.7)', () => {
  it('forms a new group from two lone sessions', () => {
    const t = taskWithSessions(2)
    const gid = asGroupId('g1')
    const id = t.join(sid('s2'), sid('s1'), 'row', gid)
    expect(id).toBe(gid)
    const group = t.groupOf(sid('s1'))
    expect(group?.id).toBe(gid)
    expect(group?.colorIndex).toBe(0)
    expect(t.groupMembers(sid('s1'))).toEqual([sid('s1'), sid('s2')])
    expect(t.groupOf(sid('s2'))?.id).toBe(gid)
    // Exact tree shape: a 'row' split of the two leaves, anchor first (review M4).
    expect(group?.tree).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: sid('s1') },
      b: { kind: 'leaf', sessionId: sid('s2') }
    })
  })

  it('extends an existing group when the anchor is already grouped', () => {
    const t = taskWithSessions(3)
    const g1 = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g1)
    const returned = t.join(sid('s3'), sid('s2'), 'col', asGroupId('unused'))
    expect(returned).toBe(g1)
    expect(t.groups()).toHaveLength(1)
    expect(t.groupMembers(sid('s1'))).toEqual(
      expect.arrayContaining([sid('s1'), sid('s2'), sid('s3')])
    )
    expect(t.groupMembers(sid('s1'))).toHaveLength(3)
    // Exact tree shape: extending splits the ANCHOR leaf (s2) in the requested
    // dir, nesting the new member under it rather than rebuilding from scratch
    // (review M5/M6/M6b).
    expect(t.groupOf(sid('s1'))!.tree).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: sid('s1') },
      b: {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: sid('s2') },
        b: { kind: 'leaf', sessionId: sid('s3') }
      }
    })
  })

  it('throws when sessionId and anchorSessionId are the same', () => {
    const t = taskWithSessions(2)
    expect(() => t.join(sid('s1'), sid('s1'), 'row', asGroupId('g1'))).toThrow(
      InvariantViolationError
    )
  })

  it('throws when the session or the anchor is not in the task', () => {
    const t = taskWithSessions(2)
    expect(() => t.join(sid('ghost'), sid('s1'), 'row', asGroupId('g1'))).toThrow(
      InvariantViolationError
    )
    expect(() => t.join(sid('s1'), sid('ghost'), 'row', asGroupId('g1'))).toThrow(
      InvariantViolationError
    )
  })

  it('throws when the two sessions are in different windows (same-window invariant)', () => {
    const t = taskWithSessions(2)
    t.session(sid('s2'))!.assignToWindow(WIN_B)
    expect(() => t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))).toThrow(
      InvariantViolationError
    )
  })

  it('leaves a different group first (dissolving it at 1 member) before joining elsewhere', () => {
    const t = taskWithSessions(3)
    const gA = asGroupId('gA')
    t.join(sid('s2'), sid('s1'), 'row', gA)
    const gB = asGroupId('gB')
    const returned = t.join(sid('s2'), sid('s3'), 'row', gB)
    expect(returned).toBe(gB)
    expect(t.groups()).toHaveLength(1)
    expect(t.groupOf(sid('s1'))).toBeUndefined()
    expect(t.groupOf(sid('s2'))?.id).toBe(gB)
    expect(t.groupOf(sid('s3'))?.id).toBe(gB)
    expect(t.sessions().map((s) => s.id)).toEqual([sid('s1'), sid('s3'), sid('s2')])
  })

  it('rebuilds the same group in place when sessionId already shares the anchor group (keeps id + color)', () => {
    const t = taskWithSessions(3)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.join(sid('s3'), sid('s2'), 'col', asGroupId('unused'))
    const before = t.groupOf(sid('s1'))!
    expect(before.id).toBe(g)
    const originalColor = before.colorIndex

    const returned = t.join(sid('s3'), sid('s1'), 'col', asGroupId('ignored'))

    expect(returned).toBe(g)
    const after = t.groupOf(sid('s1'))!
    expect(after.id).toBe(g)
    expect(after.colorIndex).toBe(originalColor)
    expect(t.groups()).toHaveLength(1)
    expect(t.groupMembers(sid('s1'))).toHaveLength(3)
    expect(t.sessions().map((s) => s.id)).toEqual([sid('s1'), sid('s3'), sid('s2')])
    // Exact tree shape: re-joining around a NEW anchor within the same group
    // rebuilds the tree from that anchor, rather than leaving the old shape
    // intact (review M8c).
    expect(after.tree).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: sid('s1') },
        b: { kind: 'leaf', sessionId: sid('s3') }
      },
      b: { kind: 'leaf', sessionId: sid('s2') }
    })
  })

  it('moves the joining tab to sit adjacent to the anchor', () => {
    const t = taskWithSessions(4)
    t.join(sid('s4'), sid('s1'), 'row', asGroupId('g1'))
    expect(t.sessions().map((s) => s.id)).toEqual([sid('s1'), sid('s4'), sid('s2'), sid('s3')])
  })
})

describe('Task split groups — leave (§5.7)', () => {
  it('places the leaving tab right after the remaining group block', () => {
    const t = taskWithSessions(4)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.join(sid('s3'), sid('s2'), 'col', asGroupId('unused'))
    t.leave(sid('s2'))
    expect(t.groupOf(sid('s2'))).toBeUndefined()
    expect(t.groupMembers(sid('s1'))).toEqual([sid('s1'), sid('s3')])
    const order = t.sessions().map((s) => s.id)
    const groupStart = order.indexOf(sid('s1'))
    const groupEnd = order.indexOf(sid('s3'))
    expect(Math.abs(groupEnd - groupStart)).toBe(1)
    expect(order[Math.max(groupStart, groupEnd) + 1]).toBe(sid('s2'))
  })

  it('dissolves a 2-member group at 1 remaining member', () => {
    const t = taskWithSessions(2)
    t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))
    t.leave(sid('s2'))
    expect(t.groups()).toHaveLength(0)
    expect(t.groupOf(sid('s1'))).toBeUndefined()
    expect(t.groupOf(sid('s2'))).toBeUndefined()
  })

  it('throws when leaving a session that is not grouped', () => {
    const t = taskWithSessions(1)
    expect(() => t.leave(sid('s1'))).toThrow(InvariantViolationError)
  })

  it('keeps the remaining block contiguous after an in-group reorder changed tab order (review M10)', () => {
    const t = taskWithSessions(4)
    t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))
    t.join(sid('s3'), sid('s2'), 'col', asGroupId('unused'))
    // Tab order (s3,s1,s2) now differs from the tree's build order (s1,s2,s3).
    t.reorderSession(sid('s3'), 0)
    t.leave(sid('s1'))
    expect(t.sessions().map((s) => s.id)).toEqual([sid('s3'), sid('s2'), sid('s1'), sid('s4')])
  })

  it('the FIRST member leaving a 2-group lands right after the remaining one (review M11)', () => {
    const t = taskWithSessions(3)
    t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))
    t.leave(sid('s1'))
    expect(t.sessions().map((s) => s.id)).toEqual([sid('s2'), sid('s1'), sid('s3')])
  })
})

describe('Task split groups — ungroup (§5.7)', () => {
  it('removes the group entirely; member tabs stay in their current order', () => {
    const t = taskWithSessions(3)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    const before = t.sessions().map((s) => s.id)
    t.ungroup(g)
    expect(t.groups()).toHaveLength(0)
    expect(t.groupOf(sid('s1'))).toBeUndefined()
    expect(t.groupOf(sid('s2'))).toBeUndefined()
    expect(t.sessions().map((s) => s.id)).toEqual(before)
  })

  it('throws for an unknown group id', () => {
    const t = taskWithSessions(2)
    expect(() => t.ungroup(asGroupId('ghost'))).toThrow(InvariantViolationError)
  })
})

describe('Task split groups — reorderSession with groups (§5.7)', () => {
  it('clamps a grouped member move to stay within its own group span', () => {
    const t = taskWithSessions(5)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.join(sid('s3'), sid('s2'), 'col', asGroupId('unused'))
    // group now spans s1,s2,s3 at indices 0..2; s4,s5 lone after
    t.reorderSession(sid('s3'), 0)
    const order = t.sessions().map((s) => s.id)
    // clamped to the group's own span: s3 can move to the FRONT of its group
    // (there's nothing left of the group to escape into here), but the group
    // as a whole still occupies the same contiguous block it always did.
    expect(order).toEqual([sid('s3'), sid('s1'), sid('s2'), sid('s4'), sid('s5')])
    // still fully grouped & contiguous
    expect(t.groupMembers(sid('s1'))).toHaveLength(3)
  })

  it('clamps a grouped member dragged PAST the far edge of its group to the span (review M1)', () => {
    const t = taskWithSessions(5)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.join(sid('s3'), sid('s2'), 'col', asGroupId('unused'))
    // group spans s1,s2,s3 at indices 0..2; s4,s5 lone after. Dragging s1 to
    // index 4 (past the group's own span, into the lone tabs) must clamp back
    // to the far edge of the group's block, not actually land at 4.
    t.reorderSession(sid('s1'), 4)
    expect(t.sessions().map((s) => s.id)).toEqual([
      sid('s2'),
      sid('s3'),
      sid('s1'),
      sid('s4'),
      sid('s5')
    ])
  })

  it('snaps a lone tab dropped inside a group to the nearer edge, favoring the left edge on a tie', () => {
    const t = taskWithSessions(5)
    const g = asGroupId('g1')
    t.join(sid('s3'), sid('s2'), 'row', g)
    // group spans s2,s3 at indices 1..2; s1,s4,s5 lone
    t.reorderSession(sid('s5'), 2)
    expect(t.sessions().map((s) => s.id)).toEqual([
      sid('s1'),
      sid('s5'),
      sid('s2'),
      sid('s3'),
      sid('s4')
    ])
  })

  it('snaps a lone tab to the actual nearer edge when distances differ', () => {
    const t = taskWithSessions(5)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.join(sid('s3'), sid('s2'), 'col', asGroupId('u1'))
    t.join(sid('s4'), sid('s3'), 'col', asGroupId('u2'))
    // group spans s1..s4 at indices 0..3; s5 lone at index 4
    t.reorderSession(sid('s5'), 3)
    expect(t.sessions().map((s) => s.id)).toEqual([
      sid('s1'),
      sid('s2'),
      sid('s3'),
      sid('s4'),
      sid('s5')
    ])
  })

  it('throws for a non-integer or negative toIndex', () => {
    const t = taskWithSessions(2)
    expect(() => t.reorderSession(sid('s1'), -1)).toThrow(InvariantViolationError)
    expect(() => t.reorderSession(sid('s1'), 0.5)).toThrow(InvariantViolationError)
  })

  it('throws for an unknown session id', () => {
    const t = taskWithSessions(1)
    expect(() => t.reorderSession(sid('ghost'), 0)).toThrow(InvariantViolationError)
  })
})

describe('Task split groups — reorderGroup (§5.7)', () => {
  it('block-moves the whole group, preserving member order, and renumbers densely', () => {
    const t = taskWithSessions(5)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.reorderGroup(g, 3)
    expect(t.sessions().map((s) => s.id)).toEqual([
      sid('s3'),
      sid('s4'),
      sid('s5'),
      sid('s1'),
      sid('s2')
    ])
    expect(t.sessions().map((s) => s.order)).toEqual([0, 1, 2, 3, 4])
  })

  it('snaps the block away from landing inside another group', () => {
    const t = taskWithSessions(5)
    const gA = asGroupId('gA')
    t.join(sid('s2'), sid('s1'), 'row', gA)
    const gB = asGroupId('gB')
    t.join(sid('s5'), sid('s4'), 'row', gB)
    // s1,s2 grouped (0,1); s3 lone (2); s4,s5 grouped (3,4)
    t.reorderGroup(gA, 2)
    expect(t.sessions().map((s) => s.id)).toEqual([
      sid('s3'),
      sid('s1'),
      sid('s2'),
      sid('s4'),
      sid('s5')
    ])
  })

  it('throws for a non-integer or negative toIndex', () => {
    const t = taskWithSessions(2)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    expect(() => t.reorderGroup(g, -1)).toThrow(InvariantViolationError)
    expect(() => t.reorderGroup(g, 1.5)).toThrow(InvariantViolationError)
  })

  it('throws for an unknown group id', () => {
    const t = taskWithSessions(2)
    expect(() => t.reorderGroup(asGroupId('ghost'), 0)).toThrow(InvariantViolationError)
  })
})

describe('Task split groups — resizeGroup (§5.7)', () => {
  it('sets the ratio on the group tree via group-tree.setRatio', () => {
    const t = taskWithSessions(2)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.resizeGroup(g, [], 0.8)
    expect(t.groupOf(sid('s1'))?.tree).toMatchObject({ ratio: 0.8 })
  })

  it('throws for an unknown group id', () => {
    const t = taskWithSessions(2)
    expect(() => t.resizeGroup(asGroupId('ghost'), [], 0.5)).toThrow(InvariantViolationError)
  })

  it('propagates InvariantViolationError for a non-finite ratio', () => {
    const t = taskWithSessions(2)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    expect(() => t.resizeGroup(g, [], Number.NaN)).toThrow(InvariantViolationError)
  })
})

describe('Task split groups — removeSession (§5.7)', () => {
  it('drops the removed session leaf and dissolves the group at 1 remaining member', () => {
    const t = taskWithSessions(2)
    t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))
    t.removeSession(sid('s1'))
    expect(t.groups()).toHaveLength(0)
    expect(t.groupOf(sid('s2'))).toBeUndefined()
    expect(t.sessions().map((s) => s.id)).toEqual([sid('s2')])
  })

  it('a 3+-member group just shrinks (no dissolve) when one member is removed', () => {
    const t = taskWithSessions(3)
    const g = asGroupId('g1')
    t.join(sid('s2'), sid('s1'), 'row', g)
    t.join(sid('s3'), sid('s2'), 'col', asGroupId('unused'))
    t.removeSession(sid('s3'))
    expect(t.groups()).toHaveLength(1)
    expect(t.groupOf(sid('s1'))?.id).toBe(g)
    expect(t.groupMembers(sid('s1'))).toEqual([sid('s1'), sid('s2')])
  })

  it('is a no-op (does not throw) when the session id is not found', () => {
    const t = taskWithSessions(1)
    expect(() => t.removeSession(sid('ghost'))).not.toThrow()
  })
})

describe('Task sessions — addSession tail placement after gaps (review C1)', () => {
  it('a new session always lands after every surviving one, even once earlier orders left gaps', () => {
    const t = taskWithSessions(4)
    const g = asGroupId('g1')
    t.join(sid('s4'), sid('s3'), 'row', g)
    t.removeSession(sid('s1'))
    t.removeSession(sid('s2'))
    // surviving orders are {2, 3} with a gap at {0, 1} — not renumbered by removeSession
    t.addSession(newSession('s5', T1, 0))
    expect(t.sessions().map((s) => s.id)).toEqual([sid('s3'), sid('s4'), sid('s5')])
    // the group is unaffected by the later addSession
    expect(t.groupMembers(sid('s3'))).toEqual([sid('s3'), sid('s4')])
  })
})

describe('Task split groups — moveToWindow (§5.7)', () => {
  it('moves a lone session alone, returning just its id', () => {
    const t = taskWithSessions(2)
    const moved = t.moveToWindow(sid('s1'), WIN_B)
    expect(moved).toEqual([sid('s1')])
    expect(t.session(sid('s1'))!.windowId).toBe(WIN_B)
  })

  it('moves a whole group: sessionId first, then groupmates in tab order', () => {
    const t = taskWithSessions(3)
    t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))
    const moved = t.moveToWindow(sid('s2'), WIN_B)
    expect(moved).toEqual([sid('s2'), sid('s1')])
    expect(t.session(sid('s1'))!.windowId).toBe(WIN_B)
    expect(t.session(sid('s2'))!.windowId).toBe(WIN_B)
    expect(t.session(sid('s3'))!.windowId).not.toBe(WIN_B)
  })

  it('throws for a session not in the task', () => {
    const t = taskWithSessions(1)
    expect(() => t.moveToWindow(sid('ghost'), WIN_B)).toThrow(InvariantViolationError)
  })
})

describe('Task split groups — color assignment (§5.7)', () => {
  it('gives the first group palette color 0', () => {
    const t = taskWithSessions(2)
    t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))
    expect(t.groupOf(sid('s1'))?.colorIndex).toBe(0)
  })

  it('gives a second group the next unused color', () => {
    const t = taskWithSessions(4)
    t.join(sid('s2'), sid('s1'), 'row', asGroupId('g1'))
    t.join(sid('s4'), sid('s3'), 'row', asGroupId('g2'))
    expect(t.groupOf(sid('s3'))?.colorIndex).toBe(1)
  })

  it('frees a color for reuse once its group dissolves', () => {
    const t = taskWithSessions(4)
    const gA = asGroupId('gA')
    t.join(sid('s2'), sid('s1'), 'row', gA)
    t.join(sid('s4'), sid('s3'), 'row', asGroupId('gB'))
    t.leave(sid('s2')) // dissolves gA (2 -> 1), frees color 0
    const t2 = t // reuse same task: form a brand-new group on the now-lone s1/s2
    t2.join(sid('s2'), sid('s1'), 'row', asGroupId('gC'))
    expect(t2.groupOf(sid('s1'))?.colorIndex).toBe(0)
  })

  it('falls back to groups.length % PALETTE_SIZE once every color is in use (review M25)', () => {
    // GROUP_COLOR_PALETTE_SIZE + 2 groups: at the time the LAST one is colored,
    // `groups.length` is GROUP_COLOR_PALETTE_SIZE + 1, so a real modulo gives 1
    // — distinct from both 0 (the first-group color) and from a mutant that
    // always falls back to 0 (e.g. `0 * groups.length`). The old version of
    // this test used exactly PALETTE_SIZE + 1 groups, where the real formula
    // ALSO evaluates to 0 — making it indistinguishable from that mutant.
    const n = GROUP_COLOR_PALETTE_SIZE + 2
    const t = taskWithSessions(n * 2)
    for (let i = 0; i < n; i++) {
      t.join(sid(`s${2 * i + 2}`), sid(`s${2 * i + 1}`), 'row', asGroupId(`g${i}`))
    }
    expect(t.groups()).toHaveLength(n)
    const lastGroup = t.groupOf(sid(`s${2 * (n - 1) + 1}`))
    expect(lastGroup?.colorIndex).toBe(1)
  })
})

describe('Task split groups — fromSnapshot drops invalid saved groups (§5.7)', () => {
  it('a group survives restore when the surviving sessions have order GAPS (normal after a close, review M20)', () => {
    // s1 at order 0, s3 at order 2 (s2 was closed), s4 at order 5 — gaps are
    // normal (removeSession never renumbers); the group's two leaves (s1, s3)
    // are still the first two sessions in tab order, so it must survive.
    const sessions = [sessionSnap('s1', 0), sessionSnap('s3', 2), sessionSnap('s4', 5)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g1'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s3') }
        },
        colorIndex: 0
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groups().map((g) => g.id)).toEqual([asGroupId('g1')])
  })

  it('drops a group with an unknown leaf (session id not in the task)', () => {
    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g1'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('ghost') }
        },
        colorIndex: 0
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groups()).toHaveLength(0)
  })

  it('drops a group whose leaf was already claimed by an earlier-validated group (first wins)', () => {
    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1), sessionSnap('s3', 2)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g1'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s2') }
        },
        colorIndex: 0
      },
      {
        id: asGroupId('g2'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s2') },
          b: { kind: 'leaf', sessionId: sid('s3') }
        },
        colorIndex: 1
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groups()).toHaveLength(1)
    expect(t.groups()[0]!.id).toBe(asGroupId('g1'))
  })

  it('drops a corrupt single-leaf marker group (e.g. a JSON-parse-failure row)', () => {
    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g-corrupt'),
        tree: { kind: 'leaf', sessionId: sid('') },
        colorIndex: 0
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groups()).toHaveLength(0)
  })

  it('drops a group whose members span two different windows', () => {
    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1, WIN_B)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g1'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s2') }
        },
        colorIndex: 0
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groups()).toHaveLength(0)
  })

  it('drops a group whose members are not contiguous in session order', () => {
    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1), sessionSnap('s3', 2)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g1'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s3') }
        },
        colorIndex: 0
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groups()).toHaveLength(0)
  })

  it('keeps a valid saved colorIndex as-is, even if it collides with another restored group', () => {
    const sessions = [
      sessionSnap('s1', 0),
      sessionSnap('s2', 1),
      sessionSnap('s3', 2),
      sessionSnap('s4', 3)
    ]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g1'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s2') }
        },
        colorIndex: 0
      },
      {
        id: asGroupId('g2'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s3') },
          b: { kind: 'leaf', sessionId: sid('s4') }
        },
        colorIndex: 0
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groups()).toHaveLength(2)
    expect(t.groupOf(sid('s1'))?.colorIndex).toBe(0)
    expect(t.groupOf(sid('s3'))?.colorIndex).toBe(0)
  })

  it('reassigns only an invalid colorIndex, without colliding with a validly-colored sibling validated later (two-pass)', () => {
    const sessions = [
      sessionSnap('s1', 0),
      sessionSnap('s2', 1),
      sessionSnap('s3', 2),
      sessionSnap('s4', 3)
    ]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('gA-invalid'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s2') }
        },
        colorIndex: 99
      },
      {
        id: asGroupId('gB-valid'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s3') },
          b: { kind: 'leaf', sessionId: sid('s4') }
        },
        colorIndex: 0
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groupOf(sid('s3'))?.colorIndex).toBe(0)
    // Exact index, not just "not 0" (review M2a/M2b): the first pass must see
    // gB's valid color 0 already taken and assign the invalid group the next
    // free index, 1 — a mutant that always falls back to 0 regardless of what
    // is taken would still pass a bare `.not.toBe(0)` on this group only
    // coincidentally; pin the real value.
    expect(t.groupOf(sid('s1'))?.colorIndex).toBe(1)
  })

  it('reassigns a colorIndex equal to the palette size, which is out of range (review M2d)', () => {
    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s2') }
        },
        colorIndex: GROUP_COLOR_PALETTE_SIZE
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groupOf(sid('s1'))?.colorIndex).toBe(0)
  })

  it('reassigns a negative colorIndex, which is out of range (review M2e)', () => {
    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s2') }
        },
        colorIndex: -1
      }
    ]
    const t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    expect(t.groupOf(sid('s1'))?.colorIndex).toBe(0)
  })

  it('drops a pathologically deep saved tree without crashing the rest of the restore', () => {
    function deepTree(depth: number): unknown {
      let node: unknown = { kind: 'leaf', sessionId: 'deep-end' }
      for (let i = 0; i < depth; i++) {
        node = {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: `deep-${i}` },
          b: node
        }
      }
      return node
    }

    const sessions = [sessionSnap('s1', 0), sessionSnap('s2', 1)]
    const groups: GroupSnapshot[] = [
      {
        id: asGroupId('g-deep'),
        tree: deepTree(200000) as GroupSnapshot['tree'],
        colorIndex: 0
      },
      {
        id: asGroupId('g-good'),
        tree: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', sessionId: sid('s1') },
          b: { kind: 'leaf', sessionId: sid('s2') }
        },
        colorIndex: 1
      }
    ]

    let t: Task | undefined
    expect(() => {
      t = Task.fromSnapshot(taskSnapWithGroups(sessions, groups))
    }).not.toThrow()
    expect(t!.groups()).toHaveLength(1)
    expect(t!.groups()[0]!.id).toBe(asGroupId('g-good'))
    expect(t!.sessions()).toHaveLength(2)
  })
})
