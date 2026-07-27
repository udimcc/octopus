import { describe, it, expect } from 'vitest'
import { WebglBudget, DEFAULT_MAX_LEASES, webglBudget } from './webgl-budget'

describe('WebglBudget (§5.3 lease pool)', () => {
  it('grants leases up to its cap, then denies (→ Canvas fallback)', () => {
    const budget = new WebglBudget(2)
    expect(budget.acquire('a')).toBe(true)
    expect(budget.acquire('b')).toBe(true)
    // Third distinct key is over the cap → denied.
    expect(budget.acquire('c')).toBe(false)
    expect(budget.size).toBe(2)
    expect(budget.has('c')).toBe(false)
  })

  it('acquire is idempotent — re-acquiring a held key keeps it and stays under cap', () => {
    const budget = new WebglBudget(1)
    expect(budget.acquire('a')).toBe(true)
    expect(budget.acquire('a')).toBe(true) // same key, no new slot consumed
    expect(budget.size).toBe(1)
    // A different key is still denied (the one slot is taken).
    expect(budget.acquire('b')).toBe(false)
  })

  it('releasing a lease lets a waiting key acquire it', () => {
    const budget = new WebglBudget(1)
    expect(budget.acquire('a')).toBe(true)
    expect(budget.acquire('b')).toBe(false)
    budget.release('a')
    expect(budget.has('a')).toBe(false)
    expect(budget.acquire('b')).toBe(true)
  })

  it('release is idempotent and safe on an unknown key', () => {
    const budget = new WebglBudget(1)
    expect(() => budget.release('never-acquired')).not.toThrow()
    budget.acquire('a')
    budget.release('a')
    budget.release('a')
    expect(budget.size).toBe(0)
  })

  it('exposes a shared app-wide budget with the documented default cap', () => {
    expect(webglBudget).toBeInstanceOf(WebglBudget)
    // The default cap leaves headroom under the browser's ~16 context limit.
    const budget = new WebglBudget()
    for (let i = 0; i < DEFAULT_MAX_LEASES; i++) expect(budget.acquire(`k${i}`)).toBe(true)
    expect(budget.acquire('one-too-many')).toBe(false)
  })
})
