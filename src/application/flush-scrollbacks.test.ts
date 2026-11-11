/**
 * `flushScrollbacks` (DESIGN §6.6): dirty-only, one transaction, a per-call byte
 * budget, and sessions marked clean only after the commit.
 */
import { describe, it, expect, vi } from 'vitest'
import { flushScrollbacks } from './flush-scrollbacks'
import { FakePersistence, FakeScrollbackStore } from './use-cases/test-fakes'
import { asSessionId } from '../domain/ids'

const s1 = asSessionId('s1')
const s2 = asSessionId('s2')
const s3 = asSessionId('s3')

function rig(): { persistence: FakePersistence; scrollbacks: FakeScrollbackStore } {
  return { persistence: new FakePersistence(), scrollbacks: new FakeScrollbackStore() }
}

describe('flushScrollbacks (§6.6)', () => {
  it('writes only dirty sessions, in one transaction, and marks them clean', () => {
    const deps = rig()
    deps.scrollbacks.append(s1, 'one')
    deps.scrollbacks.append(s2, 'two')
    expect(flushScrollbacks(deps)).toBe(2)
    expect(deps.persistence.transactions).toBe(1)
    expect(deps.persistence.savedScrollback.get(s1)?.live).toBe('one')
    expect(deps.persistence.savedScrollback.get(s2)?.live).toBe('two')
    expect([...deps.scrollbacks.dirtyEntries()]).toEqual([])

    // Only s2 produced output since: s1 is not rewritten.
    const save = vi.spyOn(deps.persistence, 'saveScrollback')
    deps.scrollbacks.append(s2, '+')
    expect(flushScrollbacks(deps)).toBe(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(s2, 'two+')
  })

  it('is a no-op (no write) when nothing is dirty', () => {
    const deps = rig()
    const save = vi.spyOn(deps.persistence, 'saveScrollback')
    expect(flushScrollbacks(deps)).toBe(0)
    expect(save).not.toHaveBeenCalled()
  })

  it('stops once the byte budget is reached; the rest stay dirty for the next call', () => {
    const deps = rig()
    deps.scrollbacks.append(s1, 'aaaa')
    deps.scrollbacks.append(s2, 'bbbb')
    deps.scrollbacks.append(s3, 'cccc')
    // The budget is checked before each write, so one write may overshoot it.
    expect(flushScrollbacks(deps, { maxBytes: 5 })).toBe(2)
    expect([...deps.scrollbacks.dirtyEntries()].map(([id]) => id)).toEqual([s3])
    expect(flushScrollbacks(deps, { maxBytes: 5 })).toBe(1)
    expect([...deps.scrollbacks.dirtyEntries()]).toEqual([])
  })

  it('a failed session write leaves only that session dirty', () => {
    const deps = rig()
    deps.scrollbacks.append(s1, 'one')
    deps.scrollbacks.append(s2, 'two')
    const real = deps.persistence.saveScrollback.bind(deps.persistence)
    vi.spyOn(deps.persistence, 'saveScrollback').mockImplementation((id, live) => {
      if (id === s1) throw new Error('disk full')
      real(id, live)
    })
    expect(flushScrollbacks(deps)).toBe(1)
    expect([...deps.scrollbacks.dirtyEntries()].map(([id]) => id)).toEqual([s1])
  })

  it('a failed commit (or a closed store) leaves everything dirty and never throws', () => {
    const deps = rig()
    deps.scrollbacks.append(s1, 'one')
    vi.spyOn(deps.persistence, 'transaction').mockImplementation((fn) => {
      fn()
      throw new Error('SQLITE_BUSY')
    })
    expect(flushScrollbacks(deps)).toBe(0)
    expect([...deps.scrollbacks.dirtyEntries()].map(([id]) => id)).toEqual([s1])
  })
})
