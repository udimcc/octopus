import { describe, it, expect } from 'vitest'
import {
  leaf,
  leafIds,
  hasLeaf,
  split,
  removeLeaf,
  setRatio,
  validate,
  MIN_RATIO,
  MAX_RATIO,
  type GroupTree
} from './group-tree'
import { asSessionId } from './ids'
import { InvariantViolationError } from './errors'

const S1 = asSessionId('s1')
const S2 = asSessionId('s2')
const S3 = asSessionId('s3')

describe('leaf / leafIds / hasLeaf', () => {
  it('leaf creates a single-session node', () => {
    expect(leaf(S1)).toEqual({ kind: 'leaf', sessionId: S1 })
  })

  it('leafIds returns a single id for a lone leaf', () => {
    expect(leafIds(leaf(S1))).toEqual([S1])
  })

  it('leafIds returns leaves in a-before-b (left/top-before-right/bottom) order', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(leafIds(tree)).toEqual([S1, S2])
  })

  it('leafIds walks nested splits depth-first', () => {
    let tree: GroupTree = leaf(S1)
    tree = split(tree, S1, 'row', S2) // row(s1, s2)
    tree = split(tree, S2, 'col', S3) // row(s1, col(s2, s3))
    expect(leafIds(tree)).toEqual([S1, S2, S3])
  })

  it('hasLeaf finds a leaf anywhere in the tree, including nested', () => {
    let tree: GroupTree = leaf(S1)
    tree = split(tree, S1, 'row', S2)
    tree = split(tree, S2, 'col', S3)
    expect(hasLeaf(tree, S1)).toBe(true)
    expect(hasLeaf(tree, S2)).toBe(true)
    expect(hasLeaf(tree, S3)).toBe(true)
  })

  it('hasLeaf is false for an absent session', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(hasLeaf(tree, S3)).toBe(false)
  })
})

describe('split', () => {
  it('splits a leaf into {dir, a: anchor, b: newId} with the default 0.5 ratio', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(tree).toEqual({ kind: 'split', dir: 'row', ratio: 0.5, a: leaf(S1), b: leaf(S2) })
  })

  it('accepts an explicit ratio', () => {
    const tree = split(leaf(S1), S1, 'col', S2, 0.3)
    expect(tree).toMatchObject({ dir: 'col', ratio: 0.3 })
  })

  it('the new leaf always lands on b (right for row, bottom for col)', () => {
    const row = split(leaf(S1), S1, 'row', S2)
    const col = split(leaf(S1), S1, 'col', S2)
    expect(row).toMatchObject({ a: { sessionId: S1 }, b: { sessionId: S2 } })
    expect(col).toMatchObject({ a: { sessionId: S1 }, b: { sessionId: S2 } })
  })

  it('splits the anchor leaf wherever it is nested in the tree', () => {
    const tree = split(leaf(S1), S1, 'row', S2) // row(s1, s2)
    const nested = split(tree, S2, 'col', S3) // row(s1, col(s2, s3))
    expect(nested).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: leaf(S1),
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf(S2), b: leaf(S3) }
    })
  })

  it('returns the tree unchanged (same reference) when the anchor is not present', () => {
    const tree = leaf(S1)
    expect(split(tree, S2, 'row', S3)).toBe(tree)
  })

  it('returns the tree unchanged (same reference) when newId already occupies a pane', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(split(tree, S1, 'row', S2)).toBe(tree)
  })
})

describe('removeLeaf', () => {
  it('removes a leaf, collapsing the parent split to the sibling subtree', () => {
    let tree: GroupTree = leaf(S1)
    tree = split(tree, S1, 'row', S2) // row(s1, s2)
    tree = split(tree, S1, 'col', S3) // row(col(s1, s3), s2)
    const result = removeLeaf(tree, S3)
    expect(result).toEqual(split(leaf(S1), S1, 'row', S2))
  })

  it('returns undefined when a 2-leaf tree is reduced to 1 (dissolve at 1)', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(removeLeaf(tree, S2)).toBeUndefined()
    expect(removeLeaf(tree, S1)).toBeUndefined()
  })

  it('removing one leaf from a 3-leaf tree keeps a valid 2-leaf result', () => {
    let tree: GroupTree = leaf(S1)
    tree = split(tree, S1, 'row', S2)
    tree = split(tree, S2, 'col', S3) // row(s1, col(s2, s3))
    const result = removeLeaf(tree, S2)
    expect(result && leafIds(result)).toEqual([S1, S3])
  })

  it('returns the tree unchanged (same reference) when the id is absent and 2+ leaves survive', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(removeLeaf(tree, S3)).toBe(tree)
  })

  it('returns undefined for an absent id when the tree itself already has fewer than 2 leaves', () => {
    // Degenerate input: a lone-leaf "tree" is already below the floor, so even a
    // no-op removal (id not present) must come back undefined, not the input.
    const tree = leaf(S1)
    expect(removeLeaf(tree, S2)).toBeUndefined()
  })
})

describe('setRatio', () => {
  it('sets the ratio of the root split node (empty path)', () => {
    const tree = split(leaf(S1), S1, 'row', S2, 0.5)
    expect(setRatio(tree, [], 0.7)).toMatchObject({ ratio: 0.7 })
  })

  it('clamps a ratio below MIN_RATIO', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(setRatio(tree, [], 0.01)).toMatchObject({ ratio: MIN_RATIO })
  })

  it('clamps a ratio above MAX_RATIO', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(setRatio(tree, [], 0.99)).toMatchObject({ ratio: MAX_RATIO })
  })

  it('addresses a nested split node by path', () => {
    let tree: GroupTree = leaf(S1)
    tree = split(tree, S1, 'row', S2) // row(s1, s2)
    tree = split(tree, S2, 'col', S3) // row(s1, col(s2, s3))
    const result = setRatio(tree, ['b'], 0.25)
    expect(result).toMatchObject({
      kind: 'split',
      a: leaf(S1),
      b: { kind: 'split', ratio: 0.25 }
    })
    // The root's own ratio is untouched by a path into its child.
    expect((result as { ratio: number }).ratio).toBe(0.5)
  })

  it('returns the same reference when the clamped ratio does not change', () => {
    const tree = split(leaf(S1), S1, 'row', S2, 0.6)
    expect(setRatio(tree, [], 0.6)).toBe(tree)
  })

  it('throws on a path that resolves to a leaf (empty path into a lone leaf)', () => {
    expect(() => setRatio(leaf(S1), [], 0.5)).toThrow(InvariantViolationError)
  })

  it('throws when the path walks past a leaf', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(() => setRatio(tree, ['a', 'a'], 0.5)).toThrow(InvariantViolationError)
  })

  it('throws on a bad path (step into a non-existent branch of a leaf)', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(() => setRatio(tree, ['b', 'a'], 0.5)).toThrow(InvariantViolationError)
  })

  it('throws on a non-finite ratio (NaN) before any clamping', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(() => setRatio(tree, [], NaN)).toThrow(InvariantViolationError)
  })

  it('throws on a non-finite ratio (+Infinity / -Infinity)', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(() => setRatio(tree, [], Infinity)).toThrow(InvariantViolationError)
    expect(() => setRatio(tree, [], -Infinity)).toThrow(InvariantViolationError)
  })
})

describe('validate', () => {
  it('accepts a well-formed tree', () => {
    const tree = split(leaf(S1), S1, 'row', S2)
    expect(validate(tree)).toEqual(tree)
  })

  it('rejects a lone leaf (fewer than 2 members)', () => {
    expect(validate(leaf(S1))).toBeUndefined()
  })

  it('rejects garbage input', () => {
    expect(validate(null)).toBeUndefined()
    expect(validate(undefined)).toBeUndefined()
    expect(validate('nonsense')).toBeUndefined()
    expect(validate(42)).toBeUndefined()
    expect(validate([])).toBeUndefined()
    expect(validate({})).toBeUndefined()
    expect(validate({ kind: 'bogus' })).toBeUndefined()
  })

  it('rejects a split with a bad direction', () => {
    expect(
      validate({
        kind: 'split',
        dir: 'diagonal',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 's1' },
        b: { kind: 'leaf', sessionId: 's2' }
      })
    ).toBeUndefined()
  })

  it('rejects a leaf with a non-string sessionId', () => {
    expect(validate({ kind: 'leaf', sessionId: 42 })).toBeUndefined()
  })

  it('rejects the whole tree on a duplicate leaf (2-leaf case), not just the repeat', () => {
    const dup = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 's1' },
      b: { kind: 'leaf', sessionId: 's1' }
    }
    expect(validate(dup)).toBeUndefined()
  })

  it('rejects the whole tree on a duplicate leaf even when 2 other leaves are unique', () => {
    const dup = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 's1' },
      b: {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 's2' },
        b: { kind: 'leaf', sessionId: 's1' }
      }
    }
    expect(validate(dup)).toBeUndefined()
  })

  it('defaults a non-finite/missing ratio to 0.5', () => {
    const result = validate({
      kind: 'split',
      dir: 'row',
      ratio: 'not-a-number',
      a: { kind: 'leaf', sessionId: 's1' },
      b: { kind: 'leaf', sessionId: 's2' }
    })
    expect(result).toMatchObject({ ratio: 0.5 })
  })

  it('clamps a finite out-of-range ratio', () => {
    const result = validate({
      kind: 'split',
      dir: 'row',
      ratio: 5,
      a: { kind: 'leaf', sessionId: 's1' },
      b: { kind: 'leaf', sessionId: 's2' }
    })
    expect(result).toMatchObject({ ratio: MAX_RATIO })
  })

  it('rejects the whole tree when a split collapses to only 1 surviving leaf', () => {
    const result = validate({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 's1' },
      b: { kind: 'bogus' }
    })
    expect(result).toBeUndefined()
  })

  it('a nested split collapsing to its B child still contributes to a valid 2+-leaf tree (review G8)', () => {
    // `sanitizeNode`'s collapse is `a ?? b`: when `a` is the corrupt side,
    // the surviving child is `b`. A mutant that always collapses to `a`
    // (dropping `b`) would turn this inner collapse into `undefined`,
    // leaving the outer split with only one surviving leaf and rejecting the
    // whole tree instead of returning the 2-leaf {s1, s2} result.
    const result = validate({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 's1' },
      b: {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { kind: 'bogus' },
        b: { kind: 'leaf', sessionId: 's2' }
      }
    })
    expect(result && leafIds(result)).toEqual([S1, S2])
  })

  it('a child that collapses to one surviving leaf can still contribute to a valid 2+-leaf tree', () => {
    const result = validate({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { kind: 'leaf', sessionId: 's1' },
        b: { kind: 'bogus' }
      },
      b: { kind: 'leaf', sessionId: 's2' }
    })
    expect(result && leafIds(result)).toEqual([S1, S2])
  })

  it('handles realistic deep nesting without crashing', () => {
    // A 50-level chain, each new leaf anchored to the previous one — exercises the
    // recursive walk at a depth well beyond anything the UI could ever produce,
    // without hitting the stack-overflow case `Task.restoreGroups`'s try/catch
    // exists to guard against (see task.test.ts for that boundary).
    let tree: GroupTree = leaf(S1)
    let anchor = S1
    for (let i = 0; i < 50; i++) {
      const id = asSessionId(`deep-${i}`)
      tree = split(tree, anchor, 'row', id)
      anchor = id
    }
    const result = validate(tree)
    expect(result).toBeDefined()
    expect(leafIds(result!)).toHaveLength(51)
  })
})
