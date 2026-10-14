import { describe, it, expect } from 'vitest'
import {
  leafIds,
  hasLeaf,
  setRatio,
  toRects,
  splitHandles,
  neighbor,
  canSplit,
  MIN_RATIO,
  MAX_RATIO,
  MIN_PANE_COLS,
  MIN_PANE_ROWS,
  type PaneRect
} from './split-layout'
import type { SplitNode } from '../../../shared/dto'

// ── fixtures ────────────────────────────────────────────────────────────────

/** A leaf node naming `sessionId` — this module no longer exports a `leaf` builder. */
function leaf(sessionId: string): SplitNode {
  return { kind: 'leaf', sessionId }
}

/** { row: a=leaf(a), b=leaf(b) } at ratio .5 */
function twoLeafRow(a = 'a', b = 'b'): SplitNode {
  return { kind: 'split', dir: 'row', ratio: 0.5, a: leaf(a), b: leaf(b) }
}

/**
 * Three leaves: root row(a | col(b over c)):
 *   a:          left 0,   top 0,   w50 h100
 *   b:          left 50,  top 0,   w50 h50
 *   c:          left 50,  top 50,  w50 h50
 */
function threeLeafNested(): SplitNode {
  return {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: leaf('a'),
    b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('b'), b: leaf('c') }
  }
}

function rectArea(r: PaneRect): number {
  return r.width * r.height
}

function overlaps(r1: PaneRect, r2: PaneRect): boolean {
  const EPS = 1e-9
  const xOverlap = Math.min(r1.left + r1.width, r2.left + r2.width) - Math.max(r1.left, r2.left)
  const yOverlap = Math.min(r1.top + r1.height, r2.top + r2.height) - Math.max(r1.top, r2.top)
  return xOverlap > EPS && yOverlap > EPS
}

// ── leafIds / hasLeaf ───────────────────────────────────────────────────────
// (The old `leaf`/`isSplit`/`split`/`remove`/`siblingOf`/`replace`/`prune`/
// `parseLayout`/`serializeLayout` mutation/parse helpers are gone — a group's
// `SplitNode` tree is now backend-owned (`GroupDTO.layout`); this module only
// reads trees for geometry.)

describe('leafIds / hasLeaf', () => {
  it('leafIds lists leaves in a-before-b (left/top-before-right/bottom) order', () => {
    expect(leafIds(undefined)).toEqual([])
    expect(leafIds(leaf('s1'))).toEqual(['s1'])
    expect(leafIds(threeLeafNested())).toEqual(['a', 'b', 'c'])
  })

  it('hasLeaf finds a session id anywhere in the tree', () => {
    const tree = threeLeafNested()
    expect(hasLeaf(tree, 'a')).toBe(true)
    expect(hasLeaf(tree, 'c')).toBe(true)
    expect(hasLeaf(tree, 'ghost')).toBe(false)
    expect(hasLeaf(undefined, 'a')).toBe(false)
  })
})

// ── setRatio ────────────────────────────────────────────────────────────────

describe('setRatio', () => {
  it('sets the ratio of the root split via an empty path', () => {
    const tree = twoLeafRow('a', 'b')
    const next = setRatio(tree, [], 0.3)
    expect((next as { ratio: number }).ratio).toBe(0.3)
  })

  it('sets the ratio of a nested split via its path', () => {
    const tree = threeLeafNested()
    const next = setRatio(tree, ['b'], 0.7)
    expect(next).toMatchObject({
      kind: 'split',
      a: { kind: 'leaf', sessionId: 'a' },
      b: { kind: 'split', ratio: 0.7 }
    })
  })

  it('clamps below MIN_RATIO', () => {
    const next = setRatio(twoLeafRow(), [], 0)
    expect((next as { ratio: number }).ratio).toBe(MIN_RATIO)
  })

  it('clamps above MAX_RATIO', () => {
    const next = setRatio(twoLeafRow(), [], 1)
    expect((next as { ratio: number }).ratio).toBe(MAX_RATIO)
  })

  it('returns the same reference when the clamped ratio equals the current one', () => {
    const tree = twoLeafRow()
    expect(setRatio(tree, [], 0.5)).toBe(tree)
    // Dragging past the clamp bound repeatedly must not keep producing new objects.
    const clampedOnce = setRatio(tree, [], 0)
    expect(setRatio(clampedOnce, [], -5)).toBe(clampedOnce)
  })

  it('returns the same reference when the path is too long (walks into a leaf)', () => {
    const tree = twoLeafRow('a', 'b')
    expect(setRatio(tree, ['a', 'a'], 0.3)).toBe(tree)
  })

  it('returns the same reference when the path walks into a non-existent branch depth', () => {
    const tree = leaf('a')
    // A leaf root with a non-empty path can't resolve to a split node.
    expect(setRatio(tree, ['a'], 0.3)).toBe(tree)
  })
})

// ── toRects ─────────────────────────────────────────────────────────────────

describe('toRects', () => {
  it('returns an empty map for an undefined tree', () => {
    expect(toRects(undefined).size).toBe(0)
  })

  it('gives a lone leaf the full 100x100 box', () => {
    const rects = toRects(leaf('a'))
    expect(rects.get('a')).toEqual({ left: 0, top: 0, width: 100, height: 100 })
  })

  it('tiles a simple row split with no overlap, areas summing to 100*100', () => {
    const rects = toRects(twoLeafRow('a', 'b'))
    const a = rects.get('a')!
    const b = rects.get('b')!
    expect(a).toEqual({ left: 0, top: 0, width: 50, height: 100 })
    expect(b).toEqual({ left: 50, top: 0, width: 50, height: 100 })
    expect(rectArea(a) + rectArea(b)).toBeCloseTo(100 * 100)
    expect(overlaps(a, b)).toBe(false)
  })

  it('tiles a simple col split with no overlap', () => {
    const tree: SplitNode = { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('a'), b: leaf('b') }
    const rects = toRects(tree)
    const a = rects.get('a')!
    const b = rects.get('b')!
    expect(a).toEqual({ left: 0, top: 0, width: 100, height: 50 })
    expect(b).toEqual({ left: 0, top: 50, width: 100, height: 50 })
    expect(overlaps(a, b)).toBe(false)
  })

  it('tiles a nested row/col tree exactly, with no pairwise overlap', () => {
    const rects = toRects(threeLeafNested())
    expect([...rects.keys()].sort()).toEqual(['a', 'b', 'c'])
    const a = rects.get('a')!
    const b = rects.get('b')!
    const c = rects.get('c')!
    expect(a).toEqual({ left: 0, top: 0, width: 50, height: 100 })
    expect(b).toEqual({ left: 50, top: 0, width: 50, height: 50 })
    expect(c).toEqual({ left: 50, top: 50, width: 50, height: 50 })
    const total = rectArea(a) + rectArea(b) + rectArea(c)
    expect(total).toBeCloseTo(100 * 100)
    const pairs: [PaneRect, PaneRect][] = [
      [a, b],
      [a, c],
      [b, c]
    ]
    for (const [r1, r2] of pairs) expect(overlaps(r1, r2)).toBe(false)
  })

  it('tiles an asymmetric-ratio nested tree exactly, no overlap', () => {
    const tree: SplitNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.25,
      a: leaf('a'),
      b: { kind: 'split', dir: 'col', ratio: 0.75, a: leaf('b'), b: leaf('c') }
    }
    const rects = toRects(tree)
    const a = rects.get('a')!
    const b = rects.get('b')!
    const c = rects.get('c')!
    expect(a.width).toBeCloseTo(25)
    expect(b.width).toBeCloseTo(75)
    expect(b.height).toBeCloseTo(75)
    expect(c.height).toBeCloseTo(25)
    const total = rectArea(a) + rectArea(b) + rectArea(c)
    expect(total).toBeCloseTo(100 * 100)
    const pairs: [PaneRect, PaneRect][] = [
      [a, b],
      [a, c],
      [b, c]
    ]
    for (const [r1, r2] of pairs) expect(overlaps(r1, r2)).toBe(false)
  })
})

// ── splitHandles ────────────────────────────────────────────────────────────

describe('splitHandles', () => {
  it('returns no handles for an undefined tree or a lone leaf', () => {
    expect(splitHandles(undefined)).toEqual([])
    expect(splitHandles(leaf('a'))).toEqual([])
  })

  it('returns one handle per split node, with its own box/path/dir/ratio', () => {
    const handles = splitHandles(twoLeafRow('a', 'b'))
    expect(handles).toHaveLength(1)
    expect(handles[0]).toMatchObject({
      path: [],
      dir: 'row',
      ratio: 0.5,
      rect: { left: 0, top: 0, width: 100, height: 100 }
    })
  })

  it('returns one handle per nested split node, each with its own path', () => {
    const handles = splitHandles(threeLeafNested())
    expect(handles).toHaveLength(2)
    const root = handles.find((h) => h.path.length === 0)!
    const inner = handles.find((h) => h.path.length === 1)!
    expect(root.dir).toBe('row')
    expect(inner.dir).toBe('col')
    expect(inner.path).toEqual(['b'])
    // The inner split's own box is the b-subtree's box (right half of root).
    expect(inner.rect).toEqual({ left: 50, top: 0, width: 50, height: 100 })
  })
})

// ── neighbor ────────────────────────────────────────────────────────────────

describe('neighbor', () => {
  it('returns undefined for an undefined tree or an absent session id', () => {
    expect(neighbor(undefined, 'a', 'right')).toBeUndefined()
    expect(neighbor(twoLeafRow('a', 'b'), 'ghost', 'right')).toBeUndefined()
  })

  it('finds the neighbor in all four directions for a simple 2x2 grid', () => {
    // row(col(a,b) | col(c,d)): a top-left, b bottom-left, c top-right, d bottom-right.
    const tree: SplitNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('a'), b: leaf('b') },
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('c'), b: leaf('d') }
    }
    expect(neighbor(tree, 'a', 'right')).toBe('c')
    expect(neighbor(tree, 'a', 'down')).toBe('b')
    expect(neighbor(tree, 'd', 'left')).toBe('b')
    expect(neighbor(tree, 'd', 'up')).toBe('c')
  })

  it('returns undefined at the boundary of the whole area', () => {
    const tree: SplitNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('a'), b: leaf('b') },
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('c'), b: leaf('d') }
    }
    expect(neighbor(tree, 'a', 'left')).toBeUndefined() // already at the left edge
    expect(neighbor(tree, 'a', 'up')).toBeUndefined() // already at the top edge
    expect(neighbor(tree, 'd', 'right')).toBeUndefined()
    expect(neighbor(tree, 'd', 'down')).toBeUndefined()
  })

  it('picks the largest-overlap neighbor among several touching panes', () => {
    // row(a | col(small-top, big-bottom)): a spans full height; to its right, the
    // bottom pane (ratio .2/.8) has far more vertical overlap with `a` than the top one.
    const tree: SplitNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: leaf('a'),
      b: { kind: 'split', dir: 'col', ratio: 0.2, a: leaf('top'), b: leaf('bottom') }
    }
    expect(neighbor(tree, 'a', 'right')).toBe('bottom')
  })

  it('tie-break: when two panes evenly split the perpendicular axis, resolves deterministically', () => {
    const tree = threeLeafNested() // a (full height) | top b/bottom c, each half
    // Both `b` [0,50] and `c` [50,100] contain `a`'s perpendicular center
    // (centerY=50) under `containsPerpendicularCenter`, since that check is
    // inclusive with EPSILON — the center sits exactly on the shared b/c boundary.
    // `b`, visited first in `toRects`' a-before-b walk order, wins the unconditional
    // `better` branch (bestOverlap starts at -Infinity) without `containsPerpendicularCenter`
    // ever being evaluated for it. `c` then ties `b`'s overlap AND satisfies
    // `containsPerpendicularCenter`, so `neighbor`'s loop overwrites `bestId` with
    // `c` — the LAST tied-and-centered candidate visited wins, not "the only one
    // that spans the center". Pin the exact id so a change to the tie-break rule is
    // caught, not just "some non-throwing id".
    expect(neighbor(tree, 'a', 'right')).toBe('c')
    // Deterministic across repeated calls on the same (pure) tree.
    expect(neighbor(tree, 'a', 'right')).toBe('c')
  })
})

// ── canSplit ────────────────────────────────────────────────────────────────

describe('canSplit', () => {
  it('allows a row split when both halves meet the minimum size', () => {
    const cellW = 10
    const cellH = 10
    const paneWidthPx = 2 * MIN_PANE_COLS * cellW // exactly at the minimum per half
    const paneHeightPx = MIN_PANE_ROWS * cellH
    expect(canSplit(paneWidthPx, paneHeightPx, cellW, cellH, 'row')).toBe(true)
  })

  it('refuses a row split when the halved width would be under MIN_PANE_COLS', () => {
    const cellW = 10
    const cellH = 10
    const paneWidthPx = 2 * MIN_PANE_COLS * cellW - 1 // just under the minimum per half
    const paneHeightPx = MIN_PANE_ROWS * cellH
    expect(canSplit(paneWidthPx, paneHeightPx, cellW, cellH, 'row')).toBe(false)
  })

  it('refuses a row split when the (unhalved) height is under MIN_PANE_ROWS', () => {
    const cellW = 10
    const cellH = 10
    const paneWidthPx = 2 * MIN_PANE_COLS * cellW
    const paneHeightPx = MIN_PANE_ROWS * cellH - 1
    expect(canSplit(paneWidthPx, paneHeightPx, cellW, cellH, 'row')).toBe(false)
  })

  it('allows a col split when both halves meet the minimum size', () => {
    const cellW = 10
    const cellH = 10
    const paneWidthPx = MIN_PANE_COLS * cellW
    const paneHeightPx = 2 * MIN_PANE_ROWS * cellH
    expect(canSplit(paneWidthPx, paneHeightPx, cellW, cellH, 'col')).toBe(true)
  })

  it('refuses a col split when the halved height would be under MIN_PANE_ROWS', () => {
    const cellW = 10
    const cellH = 10
    const paneWidthPx = MIN_PANE_COLS * cellW
    const paneHeightPx = 2 * MIN_PANE_ROWS * cellH - 1
    expect(canSplit(paneWidthPx, paneHeightPx, cellW, cellH, 'col')).toBe(false)
  })

  it('refuses a col split when the (unhalved) width is under MIN_PANE_COLS', () => {
    const cellW = 10
    const cellH = 10
    const paneWidthPx = MIN_PANE_COLS * cellW - 1
    const paneHeightPx = 2 * MIN_PANE_ROWS * cellH
    expect(canSplit(paneWidthPx, paneHeightPx, cellW, cellH, 'col')).toBe(false)
  })

  it('does not block the split when the cell size is unmeasurable (zero, negative, NaN, non-finite)', () => {
    expect(canSplit(10, 10, 0, 10, 'row')).toBe(true)
    expect(canSplit(10, 10, 10, 0, 'row')).toBe(true)
    expect(canSplit(10, 10, -5, 10, 'row')).toBe(true)
    expect(canSplit(10, 10, NaN, 10, 'row')).toBe(true)
    expect(canSplit(10, 10, 10, Infinity, 'row')).toBe(true)
  })
})
