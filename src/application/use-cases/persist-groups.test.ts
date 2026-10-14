import { describe, it, expect } from 'vitest'
import { persistGroups } from './persist-groups'
import { makeDeps } from './test-fakes'
import { asTaskId, asGroupId, asSessionId } from '../../domain/ids'
import type { GroupSnapshot } from '../../domain/snapshots'

const taskId = asTaskId('t1')

function group(id: string, a: string, b: string): GroupSnapshot {
  return {
    id: asGroupId(id),
    tree: {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: asSessionId(a) },
      b: { kind: 'leaf', sessionId: asSessionId(b) }
    },
    colorIndex: 0
  }
}

describe('persistGroups (§5.7)', () => {
  it('upserts every group present after', () => {
    const { persistence } = makeDeps()
    const after = [group('g1', 's1', 's2'), group('g2', 's3', 's4')]

    persistGroups(persistence, taskId, [], after)

    expect(persistence.groups.get(asGroupId('g1'))).toEqual({ taskId, group: after[0] })
    expect(persistence.groups.get(asGroupId('g2'))).toEqual({ taskId, group: after[1] })
  })

  it('deletes a group id present before but absent after', () => {
    const { persistence } = makeDeps()
    const before = [group('g1', 's1', 's2')]
    persistGroups(persistence, taskId, [], before)

    persistGroups(persistence, taskId, before, [])

    expect(persistence.groups.has(asGroupId('g1'))).toBe(false)
  })

  it('re-upserts a changed group (e.g. a new ratio) rather than diffing fields', () => {
    const { persistence } = makeDeps()
    const before = [group('g1', 's1', 's2')]
    persistGroups(persistence, taskId, [], before)
    const resized: GroupSnapshot = {
      ...before[0],
      tree: { ...before[0].tree, ratio: 0.75 } as never
    }

    persistGroups(persistence, taskId, before, [resized])

    expect(persistence.groups.get(asGroupId('g1'))).toEqual({ taskId, group: resized })
  })

  it('leaves an untouched group alone when before and after both carry it', () => {
    const { persistence } = makeDeps()
    const g1 = group('g1', 's1', 's2')
    const g2 = group('g2', 's3', 's4')
    persistGroups(persistence, taskId, [], [g1, g2])

    // g2 dissolves (e.g. leave-group), g1 is untouched.
    persistGroups(persistence, taskId, [g1, g2], [g1])

    expect(persistence.groups.get(asGroupId('g1'))).toEqual({ taskId, group: g1 })
    expect(persistence.groups.has(asGroupId('g2'))).toBe(false)
  })

  it('is a no-op when before and after are both empty', () => {
    const { persistence } = makeDeps()
    persistGroups(persistence, taskId, [], [])
    expect(persistence.groups.size).toBe(0)
  })
})
