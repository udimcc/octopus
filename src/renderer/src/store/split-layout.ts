/**
 * Pure split-pane GEOMETRY module (DESIGN §5.7, split-groups design). A group's
 * `SplitNode` tree (`shared/dto.ts`) is now backend-owned (`GroupDTO.layout`,
 * `src/renderer/src/store/store.ts`'s `groupsByTask`) — this module no longer
 * mutates trees, it only reads them: boxes for rendering, neighbor lookup for the
 * focus-pane chords, the minimum-size check for the split chords, and a local
 * ratio preview while a divider is being dragged (sent as one `groups.resize` on
 * release).
 *
 * Panes are rendered FLAT: `toRects` maps the tree to absolute percentage boxes
 * keyed by session id, and the caller (`TaskView`) renders every hosted session as
 * a sibling `SessionPane`, never nested inside split containers. This is load-
 * bearing for §5.3's keep-alive guarantee — if a pane's React parent changed on
 * every restructure, `TerminalPane` would remount and the xterm instance (and its
 * scrollback/sink) would be destroyed. Joining, leaving, and switching between a
 * group and a lone session must only ever change *props* on existing `SessionPane`
 * elements.
 *
 * Trees are tiny (a handful of panes at most), so every operation here is a plain
 * recursive walk — no balancing, no indexing, no mutation of inputs.
 */

import type { SplitDirection, SplitNode } from '../../../shared/dto'

/** A directional pane-focus/neighbor query, as issued by the four focus-pane chords. */
export type PaneDirection = 'left' | 'right' | 'up' | 'down'

/** A root-to-split-node path: 'a' or 'b' at each level. Identifies one split node. */
export type SplitPath = readonly ('a' | 'b')[]

/** A pane's box, in percentages (0–100) of the task's pane area. */
export interface PaneRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** One split node's own box and current ratio, for rendering its divider gutter. */
export interface SplitHandle {
  readonly path: SplitPath
  readonly dir: SplitDirection
  readonly ratio: number
  readonly rect: PaneRect
}

/** Ratio (child `a`'s share) is clamped to this range — never a degenerate pane. */
export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.9

/** Minimum pane size (§5.7 "size limit"), in terminal cells, below which a split is refused. */
export const MIN_PANE_COLS = 20
export const MIN_PANE_ROWS = 5

/** Floating-point tolerance for "two edges touch" / "overlap is tied" comparisons in `neighbor`. */
const EPSILON = 1e-6

const FULL_RECT: PaneRect = { left: 0, top: 0, width: 100, height: 100 }

/** Every session id in the tree, in left/top-before-right/bottom (`a` before `b`) order. */
export function leafIds(tree: SplitNode | undefined): string[] {
  if (!tree) return []
  if (tree.kind === 'leaf') return [tree.sessionId]
  return [...leafIds(tree.a), ...leafIds(tree.b)]
}

/** True iff some leaf in the tree shows `sessionId`. */
export function hasLeaf(tree: SplitNode | undefined, sessionId: string): boolean {
  if (!tree) return false
  if (tree.kind === 'leaf') return tree.sessionId === sessionId
  return hasLeaf(tree.a, sessionId) || hasLeaf(tree.b, sessionId)
}

/** Clamp a ratio into the allowed [MIN_RATIO, MAX_RATIO] range. */
function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/**
 * Set the ratio of the split node reached by `path` (root → split, 'a'/'b' per
 * level), clamped to [MIN_RATIO, MAX_RATIO]. Unchanged if `path` doesn't resolve
 * to a split node (too long, or walks into a leaf). Unchanged (same reference) also
 * when the clamped ratio equals the current one, so a drag pinned at a clamp bound
 * causes no re-render or save.
 */
export function setRatio(tree: SplitNode, path: SplitPath, ratio: number): SplitNode {
  const clamped = clampRatio(ratio)
  const go = (node: SplitNode, remaining: SplitPath): SplitNode => {
    if (remaining.length === 0) {
      return node.kind === 'split' && node.ratio !== clamped ? { ...node, ratio: clamped } : node
    }
    if (node.kind === 'leaf') return node
    const [step, ...rest] = remaining
    const child = step === 'a' ? node.a : node.b
    const next = go(child, rest)
    if (next === child) return node
    return step === 'a' ? { ...node, a: next } : { ...node, b: next }
  }
  return go(tree, path)
}

/** The two children's boxes once `node` divides `rect` along its direction/ratio. */
function childRects(node: SplitNode & { kind: 'split' }, rect: PaneRect): [PaneRect, PaneRect] {
  if (node.dir === 'row') {
    const aWidth = rect.width * node.ratio
    return [
      { ...rect, width: aWidth },
      { ...rect, left: rect.left + aWidth, width: rect.width - aWidth }
    ]
  }
  const aHeight = rect.height * node.ratio
  return [
    { ...rect, height: aHeight },
    { ...rect, top: rect.top + aHeight, height: rect.height - aHeight }
  ]
}

/** Shared tree walk: visits every leaf (with its box) and every split node (with its box/path). */
function walk(
  node: SplitNode,
  rect: PaneRect,
  path: SplitPath,
  onLeaf: (sessionId: string, rect: PaneRect) => void,
  onSplit: (node: SplitNode & { kind: 'split' }, rect: PaneRect, path: SplitPath) => void
): void {
  if (node.kind === 'leaf') {
    onLeaf(node.sessionId, rect)
    return
  }
  onSplit(node, rect, path)
  const [aRect, bRect] = childRects(node, rect)
  walk(node.a, aRect, [...path, 'a'], onLeaf, onSplit)
  walk(node.b, bRect, [...path, 'b'], onLeaf, onSplit)
}

/**
 * Percentage box per session id. Leaves tile the 0–100 area exactly with no
 * overlap; a lone leaf gets the full box. Empty map for an undefined tree.
 */
export function toRects(tree: SplitNode | undefined): Map<string, PaneRect> {
  const rects = new Map<string, PaneRect>()
  if (!tree) return rects
  walk(
    tree,
    FULL_RECT,
    [],
    (sessionId, rect) => rects.set(sessionId, rect),
    () => {}
  )
  return rects
}

/** One handle per split node — its own box (for divider placement), path, direction and ratio. */
export function splitHandles(tree: SplitNode | undefined): SplitHandle[] {
  const handles: SplitHandle[] = []
  if (!tree) return handles
  walk(
    tree,
    FULL_RECT,
    [],
    () => {},
    (node, rect, path) => handles.push({ path, dir: node.dir, ratio: node.ratio, rect })
  )
  return handles
}

/** The edge of `rect` facing `direction` touches the opposite edge of `other` (within EPSILON). */
function touchesInDirection(rect: PaneRect, other: PaneRect, direction: PaneDirection): boolean {
  switch (direction) {
    case 'right':
      return Math.abs(other.left - (rect.left + rect.width)) <= EPSILON
    case 'left':
      return Math.abs(other.left + other.width - rect.left) <= EPSILON
    case 'down':
      return Math.abs(other.top - (rect.top + rect.height)) <= EPSILON
    case 'up':
      return Math.abs(other.top + other.height - rect.top) <= EPSILON
  }
}

/** Overlap, along the axis perpendicular to `direction`, between `rect` and `other`. */
function perpendicularOverlap(rect: PaneRect, other: PaneRect, direction: PaneDirection): number {
  if (direction === 'left' || direction === 'right') {
    return (
      Math.min(rect.top + rect.height, other.top + other.height) - Math.max(rect.top, other.top)
    )
  }
  return (
    Math.min(rect.left + rect.width, other.left + other.width) - Math.max(rect.left, other.left)
  )
}

/** True iff `other` spans `rect`'s perpendicular-axis center (tie-break for `neighbor`). */
function containsPerpendicularCenter(
  rect: PaneRect,
  other: PaneRect,
  direction: PaneDirection
): boolean {
  if (direction === 'left' || direction === 'right') {
    const centerY = rect.top + rect.height / 2
    return centerY >= other.top - EPSILON && centerY <= other.top + other.height + EPSILON
  }
  const centerX = rect.left + rect.width / 2
  return centerX >= other.left - EPSILON && centerX <= other.left + other.width + EPSILON
}

/**
 * The pane geometrically adjacent to `sessionId`'s pane in `direction`: among
 * panes whose edge touches this pane's edge on that side, the one with the
 * largest perpendicular-axis overlap; ties broken by whichever spans this pane's
 * perpendicular center. `undefined` if `sessionId` is absent or has no neighbor
 * that way (e.g. it's already at that edge of the whole area).
 */
export function neighbor(
  tree: SplitNode | undefined,
  sessionId: string,
  direction: PaneDirection
): string | undefined {
  if (!tree) return undefined
  const rects = toRects(tree)
  const self = rects.get(sessionId)
  if (!self) return undefined

  let bestId: string | undefined
  let bestOverlap = -Infinity
  for (const [id, rect] of rects) {
    if (id === sessionId) continue
    if (!touchesInDirection(self, rect, direction)) continue
    const overlap = perpendicularOverlap(self, rect, direction)
    if (overlap <= EPSILON) continue
    const better = overlap > bestOverlap + EPSILON
    const tied = Math.abs(overlap - bestOverlap) <= EPSILON
    if (better || (tied && containsPerpendicularCenter(self, rect, direction))) {
      bestId = id
      bestOverlap = overlap
    }
  }
  return bestId
}

/**
 * Would splitting a pane of this pixel size along `dir` (at ratio 0.5 — the
 * worst case, since any user-dragged ratio only widens one side at the other's
 * expense) leave both halves at least `MIN_PANE_COLS` x `MIN_PANE_ROWS` cells?
 * A non-positive or non-finite cell size means the caller couldn't measure the
 * terminal's cell metrics yet — don't block the split on missing data.
 */
export function canSplit(
  paneWidthPx: number,
  paneHeightPx: number,
  cellWidthPx: number,
  cellHeightPx: number,
  dir: SplitDirection
): boolean {
  if (!Number.isFinite(cellWidthPx) || cellWidthPx <= 0) return true
  if (!Number.isFinite(cellHeightPx) || cellHeightPx <= 0) return true
  const halfWidthPx = dir === 'row' ? paneWidthPx / 2 : paneWidthPx
  const halfHeightPx = dir === 'col' ? paneHeightPx / 2 : paneHeightPx
  const cols = halfWidthPx / cellWidthPx
  const rows = halfHeightPx / cellHeightPx
  return cols >= MIN_PANE_COLS && rows >= MIN_PANE_ROWS
}
