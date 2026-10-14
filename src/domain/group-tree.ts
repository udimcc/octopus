/**
 * Pure split-group layout tree (DESIGN §5.7 Split groups). A `Group` (defined on
 * `Task`, see `task.ts`) pairs one of these trees with an id and a color;
 * membership is the tree's leaves — there is no separate member list to keep in
 * sync. The tree is intentionally STRUCTURALLY IDENTICAL to the renderer-facing
 * `SplitNode` in `src/shared/dto.ts` (same field names, discriminants and
 * direction literals) so the `main`-layer mapper can convert between them by
 * re-branding leaf ids only, with no shape translation. The domain cannot import
 * `shared` (dependency rule), so the type is re-declared here rather than
 * imported.
 *
 * Trees are tiny (a handful of panes at most): every operation is a plain
 * recursive walk, no balancing or input mutation.
 */

import type { SessionId } from './ids'
import { InvariantViolationError } from './errors'

/** 'row' = children side by side, a left/b right ("split right"); 'col' = stacked, a top/b bottom ("split down"). */
export type SplitDirection = 'row' | 'col'

export type GroupTree =
  | { readonly kind: 'leaf'; readonly sessionId: SessionId }
  | {
      readonly kind: 'split'
      readonly dir: SplitDirection
      readonly ratio: number
      readonly a: GroupTree
      readonly b: GroupTree
    }

/** A root-to-split-node path: 'a' or 'b' at each level. Identifies one split node. */
export type GroupPath = readonly ('a' | 'b')[]

/** Ratio (child `a`'s share) is clamped to this range — never a degenerate pane. */
export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.9

/** A single-session leaf node. */
export function leaf(sessionId: SessionId): GroupTree {
  return { kind: 'leaf', sessionId }
}

/** Every session id in the tree, in left/top-before-right/bottom (`a` before `b`) order. */
export function leafIds(tree: GroupTree): SessionId[] {
  if (tree.kind === 'leaf') return [tree.sessionId]
  return [...leafIds(tree.a), ...leafIds(tree.b)]
}

/** True iff some leaf in the tree shows `sessionId`. */
export function hasLeaf(tree: GroupTree, sessionId: SessionId): boolean {
  if (tree.kind === 'leaf') return tree.sessionId === sessionId
  return hasLeaf(tree.a, sessionId) || hasLeaf(tree.b, sessionId)
}

function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/**
 * Split the leaf showing `anchorId` into `{dir, a: <anchor>, b: <newId>}` — the
 * new leaf always lands on the right (`dir: 'row'`) or bottom (`dir: 'col'`).
 * Returns `tree` unchanged (same reference) if the anchor isn't in the tree, or
 * `newId` already is — a session occupies at most one pane.
 */
export function split(
  tree: GroupTree,
  anchorId: SessionId,
  dir: SplitDirection,
  newId: SessionId,
  ratio = 0.5
): GroupTree {
  if (!hasLeaf(tree, anchorId) || hasLeaf(tree, newId)) return tree
  const go = (node: GroupTree): GroupTree => {
    if (node.kind === 'leaf') {
      return node.sessionId === anchorId
        ? { kind: 'split', dir, ratio, a: node, b: leaf(newId) }
        : node
    }
    return hasLeaf(node, anchorId) ? { ...node, a: go(node.a), b: go(node.b) } : node
  }
  return go(tree)
}

/**
 * Drop the leaf showing `sessionId`; its parent split collapses to the sibling
 * subtree. Returns `undefined` if the tree would end up with FEWER THAN 2 leaves
 * — either because `sessionId` was the tree's lone root leaf, or because
 * removing it leaves only one sibling leaf behind. Both cases mean "this is no
 * longer a group" (DESIGN §5.7 "dissolve at 1 member"); `Task` reads `undefined`
 * as the signal to drop the whole group rather than keep a 1-leaf tree around.
 * Returns `tree` unchanged if `sessionId` isn't present — UNLESS `tree` itself
 * already has fewer than 2 leaves (a malformed/degenerate input): the same
 * 2-leaf floor check applies regardless of whether anything was removed, so a
 * tree that was already too small comes back `undefined` too. A real `Task`
 * group never hits that edge, since it never shrinks below 2 members without
 * dissolving (the group row is dropped the moment this returns `undefined`).
 */
export function removeLeaf(tree: GroupTree, sessionId: SessionId): GroupTree | undefined {
  const go = (node: GroupTree): GroupTree | undefined => {
    if (node.kind === 'leaf') return node.sessionId === sessionId ? undefined : node
    if (hasLeaf(node.a, sessionId)) {
      const next = go(node.a)
      return next === undefined ? node.b : { ...node, a: next }
    }
    if (hasLeaf(node.b, sessionId)) {
      const next = go(node.b)
      return next === undefined ? node.a : { ...node, b: next }
    }
    return node
  }
  const result = go(tree)
  if (result === undefined) return undefined
  return leafIds(result).length >= 2 ? result : undefined
}

/**
 * Set the ratio of the split node reached by `path` (root → split, 'a'/'b' per
 * level), clamped to [MIN_RATIO, MAX_RATIO]. Unlike the renderer's geometry-only
 * `setRatio` (which silently no-ops on a bad path, since it's fed paths it just
 * read off the same tree), this one THROWS on a path that doesn't resolve to a
 * split node — a bad path here means an application-layer bug (a stale/foreign
 * path reaching `Task`), which should fail loudly rather than be swallowed, the
 * same way `Task.reorderSession` throws on an unknown session id rather than
 * silently no-op-ing.
 *
 * Also throws on a non-finite `ratio` (review m2): `clampRatio`'s
 * `Math.min`/`Math.max` let a `NaN` straight through (any comparison against
 * `NaN` is `false`), so without this guard a bad ratio would silently persist
 * as `NaN` instead of being rejected. `resizeGroup`'s IPC handler already
 * blocks this at the wire boundary, but `Task.resizeGroup` can be reached by
 * other application code too, so the domain guards itself rather than trusting
 * every caller to pre-validate.
 */
export function setRatio(tree: GroupTree, path: GroupPath, ratio: number): GroupTree {
  if (!Number.isFinite(ratio)) {
    throw new InvariantViolationError('group-tree: ratio must be a finite number')
  }
  const clamped = clampRatio(ratio)
  const go = (node: GroupTree, remaining: GroupPath): GroupTree => {
    if (remaining.length === 0) {
      if (node.kind !== 'split') {
        throw new InvariantViolationError('group-tree: path does not resolve to a split node')
      }
      return node.ratio === clamped ? node : { ...node, ratio: clamped }
    }
    if (node.kind === 'leaf') {
      throw new InvariantViolationError('group-tree: path walks into a leaf')
    }
    const [step, ...rest] = remaining
    const child = step === 'a' ? node.a : node.b
    const next = go(child, rest)
    if (next === child) return node
    return step === 'a' ? { ...node, a: next } : { ...node, b: next }
  }
  return go(tree, path)
}

/** Narrow, defensive read of an untrusted (parsed-JSON) value's property. */
function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/**
 * Validate and sanitize one node of untrusted input, tracking already-used ids
 * in `seen` to detect a duplicate (second occurrence of the same leaf): rather
 * than silently keeping the first occurrence and dropping the second (a
 * "repair"), a duplicate flips `flags.duplicate` so the caller (`validate`)
 * rejects the WHOLE tree — DESIGN §5.7 says a group with duplicate leaves is
 * "dropped instead of failing the load", i.e. the group, not just the
 * offending leaf (review m3). The duplicate leaf itself still returns
 * `undefined` here so the recursive walk can finish without throwing. A split
 * whose only surviving child is one node collapses to that child. A ratio that
 * isn't a finite number defaults to 0.5; a finite one is clamped into
 * [MIN_RATIO, MAX_RATIO] (the "finite ratios clamped" requirement — a
 * non-finite ratio isn't a borderline value to clamp, it's absent/corrupt
 * data, so it gets the same default a fresh split uses).
 */
function sanitizeNode(
  node: unknown,
  seen: Set<SessionId>,
  flags: { duplicate: boolean }
): GroupTree | undefined {
  const kind = prop(node, 'kind')
  if (kind === 'leaf') {
    const sessionId = prop(node, 'sessionId')
    if (typeof sessionId !== 'string') {
      return undefined
    }
    const id = sessionId as SessionId
    if (seen.has(id)) {
      flags.duplicate = true
      return undefined
    }
    seen.add(id)
    return leaf(id)
  }
  if (kind === 'split') {
    const dir = prop(node, 'dir')
    if (dir !== 'row' && dir !== 'col') return undefined
    const rawRatio = prop(node, 'ratio')
    const ratio =
      typeof rawRatio === 'number' && Number.isFinite(rawRatio) ? clampRatio(rawRatio) : 0.5
    const a = sanitizeNode(prop(node, 'a'), seen, flags)
    const b = sanitizeNode(prop(node, 'b'), seen, flags)
    if (a && b) return { kind: 'split', dir, ratio, a, b }
    return a ?? b
  }
  return undefined
}

/**
 * Validate an untrusted (e.g. deserialized-from-persistence) value as a
 * `GroupTree`: strict shape/direction checks, unique leaves (a duplicate
 * rejects the whole tree, not just the repeat — see `sanitizeNode`), finite
 * ratios clamped. Returns `undefined` unless at least 2 leaves survive — a
 * group always has 2+ members. This checks only the tree's OWN internal
 * consistency; it does not know which session ids are real, whether they're
 * shared with another group, or whether they're contiguous in the task's
 * session order — those cross-group/cross-session checks are
 * `Task.fromSnapshot`'s job (DESIGN §5.7 "loading tolerates bad saved data"),
 * since this module has no visibility into other groups or sessions.
 */
export function validate(tree: unknown): GroupTree | undefined {
  const flags = { duplicate: false }
  const sanitized = sanitizeNode(tree, new Set<SessionId>(), flags)
  if (!sanitized || flags.duplicate) return undefined
  return leafIds(sanitized).length >= 2 ? sanitized : undefined
}
