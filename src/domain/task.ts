/**
 * `Task` aggregate root (DESIGN §3.1, §3.2, §3.5). The consistency boundary for
 * its sessions: every add/remove/reorder/state change goes through it, and it
 * derives `TaskState` (I11 — never assigned). Cross-aggregate references are by
 * id only (§3.1).
 *
 * A `Ready` task holds a `WorktreeRef` UNLESS it is a "No Repo" task (I1'):
 * `Ready ⇒ (has worktree) XOR repoLess`. A repo-less task (§5.4) is permanently
 * `Ready` with no worktree — its sessions open at the home dir. Provisioning
 * status lives in `TaskLifecycle` (§3.5).
 */

import type { TaskId, SessionId, GroupId, WindowId } from './ids'
import { TaskState } from './state'
import { TaskLifecycle, canTransitionTask } from './lifecycle'
import { WorktreeRef } from './worktree-ref'
import { Session } from './session'
import type { TaskStateAggregator } from './task-state-aggregator'
import type { TaskSnapshot, GroupSnapshot } from './snapshots'
import { IllegalTransitionError, InvariantViolationError } from './errors'
import {
  type GroupTree,
  type GroupPath,
  type SplitDirection,
  leaf,
  split,
  removeLeaf,
  setRatio,
  leafIds,
  hasLeaf,
  validate as validateGroupTree
} from './group-tree'

export interface TaskCreateProps {
  id: TaskId
  name: string
  position: number
  createdAt: number
}

/**
 * A split group (DESIGN §5.7): 2+ sessions of this task, in one window, sharing
 * a layout tree and a palette color. Membership is `tree`'s leaves — there is
 * no separate member list and no group pointer on `Session`, so there is
 * nothing to reconcile; `Task` is the only place that mutates the list.
 */
export interface Group {
  readonly id: GroupId
  readonly tree: GroupTree
  readonly colorIndex: number
}

/** Fixed palette size (DESIGN §5.7 "6 colors"); a group's `colorIndex` is `0..GROUP_COLOR_PALETTE_SIZE-1`. */
export const GROUP_COLOR_PALETTE_SIZE = 6

export class Task {
  readonly id: TaskId
  readonly createdAt: number

  private _name: string
  private _lifecycle: TaskLifecycle
  private _worktree?: WorktreeRef
  private _repoLess = false
  private _sessions: Session[]
  private _activeSessionId?: SessionId
  private _position: number
  private _groups: Group[]

  private constructor(props: TaskCreateProps, lifecycle: TaskLifecycle) {
    this.id = props.id
    this.createdAt = props.createdAt
    this._name = props.name
    this._lifecycle = lifecycle
    this._sessions = []
    this._position = props.position
    this._groups = []
  }

  /** Create a task in `None`; `createTask` immediately drives it to `Provisioning` (§3.5). */
  static create(props: TaskCreateProps): Task {
    return new Task(props, TaskLifecycle.None)
  }

  /** Reconstruct a task (and its sessions) from persistence (I15). */
  static fromSnapshot(snap: TaskSnapshot): Task {
    const t = new Task(
      { id: snap.id, name: snap.name, position: snap.position, createdAt: snap.createdAt },
      snap.lifecycle
    )
    if (snap.worktree) {
      t._worktree = WorktreeRef.create(snap.worktree)
    }
    t._repoLess = snap.repoLess ?? false
    t._sessions = snap.sessions
      .map((s) => Session.fromSnapshot(s))
      .sort((a, b) => a.order - b.order)
    // Restore the active session only if it still resolves to a held session (I10).
    if (snap.activeSessionId && t._sessions.some((s) => s.id === snap.activeSessionId)) {
      t._activeSessionId = snap.activeSessionId
    }
    t._groups = snap.groups ? t.restoreGroups(snap.groups) : []
    return t
  }

  /**
   * Validate each saved group against the sessions just restored above
   * (DESIGN §5.7 "loading tolerates bad saved data") and drop — never throw —
   * any that fails: unknown leaf, a leaf reused by an earlier (and therefore
   * winning) group, fewer than 2 surviving members, members split across
   * windows, members not contiguous in the restored session order, or a
   * non-integer/out-of-palette `colorIndex`. Two passes (round-3 fix — a
   * single pass was order-dependent: an invalid-colored group validated
   * earlier in `saved` could steal the palette slot a later, validly-colored
   * group also claims, before that later group's color was even known).
   * Pass 1 validates and keeps every VALID saved `colorIndex` as-is — even if
   * it collides with another restored group's, only an INVALID one gets
   * reassigned. Pass 2, run only once every surviving group's valid color is
   * known, gives each group whose saved color was invalid the first palette
   * slot not already used by any group of the task (review m5 — same
   * `nextColorIndex()` a NEW group gets, rather than dropping the group over
   * cosmetic metadata; round-2 fix — an unconditional fallback to color 0
   * could collide with another restored group's color, same "corrupt data
   * gets a default" convention `group-tree.ts`'s ratio sanitizer uses, just
   * collision-aware; round-3 makes that collision check order-independent).
   * Must run after `_sessions` is populated, since contiguity and window
   * checks need it.
   *
   * `validateGroupTree` is a plain recursive walk with no depth limit (review
   * m4): a pathologically deep/corrupt saved `tree` JSON can overflow the stack
   * (`RangeError`). Each saved group is validated in its OWN try/catch so that
   * failure drops just THIS one row, not the whole load — a bad group must
   * never take down every other task's groups (or sessions) with it.
   */
  private restoreGroups(saved: readonly GroupSnapshot[]): Group[] {
    const sessionIds = new Set(this._sessions.map((s) => s.id))
    const orderedIds = this.sessions().map((s) => s.id)
    const usedLeaves = new Set<SessionId>()
    // Pass 1: validate; `colorIndex: undefined` is a placeholder for an invalid saved
    // color, resolved in pass 2 below once every survivor's VALID color is known.
    const pending: Array<{ id: GroupId; tree: GroupTree; colorIndex: number | undefined }> = []

    for (const g of saved) {
      let tree: GroupTree | undefined
      try {
        tree = validateGroupTree(g.tree)
      } catch {
        continue
      }
      if (!tree) continue
      const ids = leafIds(tree)
      if (ids.length < 2) continue
      if (ids.some((id) => !sessionIds.has(id) || usedLeaves.has(id))) continue

      const windowIds = new Set(ids.map((id) => this.session(id)!.windowId))
      if (windowIds.size > 1) continue

      const positions = ids.map((id) => orderedIds.indexOf(id)).sort((a, b) => a - b)
      const isContiguous = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1)
      if (!isContiguous) continue

      ids.forEach((id) => usedLeaves.add(id))
      const validColor =
        Number.isInteger(g.colorIndex) &&
        g.colorIndex >= 0 &&
        g.colorIndex < GROUP_COLOR_PALETTE_SIZE
      pending.push({ id: g.id, tree, colorIndex: validColor ? g.colorIndex : undefined })
    }

    // Pass 2: every surviving group is in `pending` now, so every VALID saved color is
    // already known — fill each placeholder against the FULL set (prior invalid-color
    // fixes in this loop + every valid color, regardless of where it sits in `saved`),
    // not just whichever groups happened to validate earlier.
    const restored: Group[] = pending.map((g) => ({
      id: g.id,
      tree: g.tree,
      colorIndex: g.colorIndex ?? -1
    }))
    pending.forEach((g, i) => {
      if (g.colorIndex === undefined) {
        restored[i] = { ...restored[i], colorIndex: this.nextColorIndex(restored) }
      }
    })
    return restored
  }

  get name(): string {
    return this._name
  }
  get lifecycle(): TaskLifecycle {
    return this._lifecycle
  }
  get worktree(): WorktreeRef | undefined {
    return this._worktree
  }
  /** True for a "No Repo" task (§5.4): `Ready` with no worktree (I1'). */
  get repoLess(): boolean {
    return this._repoLess
  }
  get activeSessionId(): SessionId | undefined {
    return this._activeSessionId
  }
  get position(): number {
    return this._position
  }

  rename(name: string): void {
    this._name = name
  }

  setPosition(position: number): void {
    this._position = position
  }

  /** Ordered snapshot of the task's sessions (by `order`). */
  sessions(): readonly Session[] {
    return [...this._sessions].sort((a, b) => a.order - b.order)
  }

  session(id: SessionId): Session | undefined {
    return this._sessions.find((s) => s.id === id)
  }

  // ── Lifecycle (§3.5) ────────────────────────────────────────────────────────

  private transition(to: TaskLifecycle): void {
    if (!canTransitionTask(this._lifecycle, to)) {
      throw new IllegalTransitionError(
        `task ${this.id}: illegal transition ${this._lifecycle} → ${to}`
      )
    }
    this._lifecycle = to
  }

  /** `None → Provisioning`: the create script is about to run (§3.5). */
  markProvisioning(): void {
    this.transition(TaskLifecycle.Provisioning)
  }

  /**
   * `Provisioning → Ready`: attach the validated worktree (I1). The worktree is
   * required to reach `Ready` and is immutable thereafter (I2).
   */
  markReady(worktree: WorktreeRef): void {
    this.transition(TaskLifecycle.Ready)
    this._worktree = worktree
  }

  /**
   * `Provisioning → Ready` for a "No Repo" task (§5.4): reach `Ready` with NO
   * worktree and flag the task repo-less (I1'). Reuses the existing
   * `Provisioning → Ready` transition, so no new lifecycle edge is introduced.
   */
  markReadyNoRepo(): void {
    this.transition(TaskLifecycle.Ready)
    this._repoLess = true
  }

  /** `Provisioning → ProvisionFailed`: create script/validation failed (§3.5). */
  markProvisionFailed(): void {
    this.transition(TaskLifecycle.ProvisionFailed)
  }

  /** Enter `Deleting`: the strict teardown sequence begins (I3). */
  markDeleting(): void {
    this.transition(TaskLifecycle.Deleting)
  }

  /** `Deleting → Deleted` or discard a failed provision (§3.5). */
  markDeleted(): void {
    this.transition(TaskLifecycle.Deleted)
  }

  /** `Deleting → DeleteFailed`: delete script failed; retains metadata (I4). */
  markDeleteFailed(): void {
    this.transition(TaskLifecycle.DeleteFailed)
  }

  /** `Ready → Stale`: worktree missing on startup reconciliation (I14). */
  markStale(): void {
    this.transition(TaskLifecycle.Stale)
  }

  // ── Sessions (§3.2) ──────────────────────────────────────────────────────────

  /**
   * Add a session to this task. Enforces I7 (a session belongs to exactly one
   * task and cannot move between tasks): the session's `taskId` must match.
   *
   * ALWAYS places the new session at the tail — `order` set to one past the
   * highest `order` currently in use, overwriting whatever `order` the caller
   * constructed the session with (review C1). `removeSession` leaves gaps in
   * `order` (no renumber on close), so a naive `this._sessions.length` (what the
   * old call site used) can collide with a SURVIVING session's `order` after a
   * close — e.g. T1..T4 (orders 0-3), close T1 and T2, a new T5 would compute
   * `length === 2`, colliding with T3's `order`. The stable sort in `sessions()`
   * then puts T5 BEFORE T3/T4 (reversing the renderer's append-at-end tab), and
   * on restart the `sessions` table has no tiebreak, so the order is not even
   * guaranteed to round-trip the same way — silently breaking group contiguity.
   * Computing the true max here means a lone new tab always lands after every
   * existing one, independent of how many sessions were ever closed.
   */
  addSession(session: Session): void {
    if (session.taskId !== this.id) {
      throw new InvariantViolationError(
        `session ${session.id} belongs to task ${session.taskId}, not ${this.id} (I7)`
      )
    }
    if (this._sessions.some((s) => s.id === session.id)) {
      throw new InvariantViolationError(`session ${session.id} already in task ${this.id}`)
    }
    const maxOrder = this._sessions.reduce((max, s) => Math.max(max, s.order), -1)
    session.setOrder(maxOrder + 1)
    this._sessions.push(session)
    // First session becomes active by default (I10 holds trivially).
    if (this._activeSessionId === undefined) {
      this._activeSessionId = session.id
    }
  }

  /**
   * Remove a session by id; fixes up the active pointer to preserve I10. Also
   * drops the session's leaf from its group, if any (dissolving the group at 1
   * remaining member) — the leaving session itself is gone, so there is no tab
   * to reposition, unlike `leave` below.
   */
  removeSession(id: SessionId): void {
    const idx = this._sessions.findIndex((s) => s.id === id)
    if (idx === -1) {
      return
    }
    this.dropLeafFromGroup(id)
    this._sessions.splice(idx, 1)
    if (this._activeSessionId === id) {
      // Fall back to the first remaining session, or none (I10).
      const remaining = this.sessions()
      this._activeSessionId = remaining.length > 0 ? remaining[0].id : undefined
    }
  }

  /**
   * Move a session to a new index in the ordered tab list, renumbering `order`
   * on every session so it stays a dense 0..n-1 sequence.
   *
   * A GROUPED session (a group member) is clamped to its own group's
   * contiguous span (I "members contiguous in session order") rather than the
   * whole list, so it can reorder among its groupmates but never leave the
   * block. A LONE session may move anywhere EXCEPT strictly between two
   * members of some other group — that would split that group — so it snaps to
   * the nearer edge of that group instead (ties favor the earlier/left edge;
   * see `snapInsertionIndex`).
   */
  reorderSession(id: SessionId, toIndex: number): void {
    // Defensive guard (review m1), consistent with how `reorderGroup`'s IPC
    // handler validates `toIndex` — but enforced here too, in the domain, since
    // `Task` is called directly by use cases/tests, not only through IPC.
    if (!Number.isInteger(toIndex) || toIndex < 0) {
      throw new InvariantViolationError(
        `reorderSession: toIndex must be a non-negative integer, got ${toIndex}`
      )
    }
    const ordered = [...this.sessions()]
    const from = ordered.findIndex((s) => s.id === id)
    if (from === -1) {
      throw new InvariantViolationError(`session ${id} not in task ${this.id}`)
    }
    const clamped = Math.max(0, Math.min(toIndex, ordered.length - 1))
    const [moved] = ordered.splice(from, 1)

    const group = this.groupOf(id)
    const insertAt = group
      ? this.clampToGroupSpan(group, ordered)(clamped)
      : this.snapInsertionIndex(clamped, ordered)

    ordered.splice(insertAt, 0, moved)
    ordered.forEach((s, i) => s.setOrder(i))
  }

  // ── Split groups (§5.7) ──────────────────────────────────────────────────────

  /** Every split group of this task. */
  groups(): readonly Group[] {
    return [...this._groups]
  }

  /** The group containing `sessionId`, if it's a member of one. */
  groupOf(sessionId: SessionId): Group | undefined {
    return this._groups.find((g) => hasLeaf(g.tree, sessionId))
  }

  /**
   * All ids in `sessionId`'s group, in tab (session-order) order — or just
   * `[sessionId]` if it's lone. The application layer uses this to move or
   * detach a whole group as one unit.
   */
  groupMembers(sessionId: SessionId): SessionId[] {
    const group = this.groupOf(sessionId)
    return group ? this.tabOrderedLeafIds(group.tree) : [sessionId]
  }

  /**
   * Reassign `sessionId` AND its whole group (or just itself, if lone) to
   * `windowId` (DESIGN §5.7 "Moving a group" / review I2). The "every group
   * member shares one window" invariant is enforced HERE, in `Task`, rather than
   * leaving it to callers to loop over `groupMembers` and call the PUBLIC
   * `Session.assignToWindow` themselves — a caller that moved only one member
   * would silently violate the invariant with no domain-level guard against it.
   *
   * Returns the moved ids with `sessionId` FIRST, then its groupmates in tab
   * order: the application layer publishes one `sessionMovedToWindow` per id in
   * THIS order, tagging every id after the first with `cause: 'groupMove'`, so
   * the target window's mark lands on the member that was actually sent, not
   * whichever groupmate happens to sort first in the tree (§5.7 "the target
   * marks only the member that was sent").
   */
  moveToWindow(sessionId: SessionId, windowId: WindowId): SessionId[] {
    if (!this.session(sessionId)) {
      throw new InvariantViolationError(`moveToWindow: session ${sessionId} not in task ${this.id}`)
    }
    const members = this.groupMembers(sessionId)
    const ordered = [sessionId, ...members.filter((id) => id !== sessionId)]
    for (const id of ordered) {
      this.session(id)!.assignToWindow(windowId)
    }
    return ordered
  }

  /**
   * Join `sessionId` next to `anchorSessionId`'s pane (DESIGN §5.7 "Split right
   * / Split down"). Both must be sessions of THIS task, distinct, and share a
   * window (I "members share a window") — else `InvariantViolationError`.
   *
   * If `sessionId` is already in a DIFFERENT group than the anchor's, it leaves
   * that group first (dissolving it at 1 remaining member, same as `leave`).
   * If `sessionId` is already in the SAME group as the anchor (review round-2
   * minor fix), the group's tree is rebuilt in place around the anchor instead
   * — `leave()` then re-creating would mint a fresh id/color even though the
   * member set is unchanged, just reshaped; rebuilding in place keeps the
   * group's `id` and `colorIndex` (both groups-of-3+ and the 2-member case,
   * where "the remainder" is just the anchor's own leaf). Otherwise: if the
   * anchor is lone, a NEW group forms using `newGroupId` with the anchor's
   * color-palette pick; else `sessionId` joins the anchor's existing group
   * (`newGroupId` goes unused) by splitting the anchor's leaf in place. Either
   * way `sessionId`'s tab moves to immediately after the anchor's. Returns the
   * id of the group that was used (new, existing or rebuilt-in-place) —
   * `Task` never invents ids itself (the id generator port does), so the
   * caller must pass one in even when it may not be needed.
   */
  join(
    sessionId: SessionId,
    anchorSessionId: SessionId,
    dir: SplitDirection,
    newGroupId: GroupId
  ): GroupId {
    const session = this.session(sessionId)
    const anchor = this.session(anchorSessionId)
    if (!session || !anchor) {
      throw new InvariantViolationError(
        `join: both ${sessionId} and ${anchorSessionId} must be sessions of task ${this.id}`
      )
    }
    if (sessionId === anchorSessionId) {
      throw new InvariantViolationError('join: a session cannot join its own pane')
    }
    if (session.windowId !== anchor.windowId) {
      throw new InvariantViolationError(
        `join: ${sessionId} and ${anchorSessionId} are in different windows`
      )
    }

    const sessionGroup = this.groupOf(sessionId)
    const anchorGroup = this.groupOf(anchorSessionId)

    if (sessionGroup && anchorGroup && sessionGroup.id === anchorGroup.id) {
      const idx = this._groups.findIndex((g) => g.id === sessionGroup.id)
      const withoutSession = removeLeaf(sessionGroup.tree, sessionId)
      // `undefined` only for the 2-member case (sessionId/anchorSessionId are
      // the group's only members): the remainder is just the anchor's own leaf.
      const base = withoutSession ?? leaf(anchorSessionId)
      this._groups[idx] = {
        ...sessionGroup,
        tree: split(base, anchorSessionId, dir, sessionId)
      }
      this.moveSessionAdjacentTo(sessionId, anchorSessionId)
      return sessionGroup.id
    }

    if (sessionGroup) {
      this.leave(sessionId)
    }

    let groupId: GroupId
    if (anchorGroup) {
      const idx = this._groups.findIndex((g) => g.id === anchorGroup.id)
      this._groups[idx] = {
        ...anchorGroup,
        tree: split(anchorGroup.tree, anchorSessionId, dir, sessionId)
      }
      groupId = anchorGroup.id
    } else {
      this._groups.push({
        id: newGroupId,
        tree: split(leaf(anchorSessionId), anchorSessionId, dir, sessionId),
        colorIndex: this.nextColorIndex()
      })
      groupId = newGroupId
    }

    this.moveSessionAdjacentTo(sessionId, anchorSessionId)
    return groupId
  }

  /**
   * Remove `sessionId` from its group, becoming lone; its tab moves to
   * immediately after the (remaining) group's block. The group DISSOLVES if
   * this leaves only 1 member (DESIGN §5.7 "dissolve at 1 member") — in that
   * case the lone remaining member keeps its current tab position and only
   * `sessionId` moves, landing right after it.
   *
   * Throws if `sessionId` isn't currently in a group — a lone session has
   * nothing to leave, so this is a programming-error signal to the caller
   * rather than a silent no-op (mirrors `reorderSession`'s unknown-id throw).
   */
  leave(sessionId: SessionId): void {
    const group = this.groupOf(sessionId)
    if (!group) {
      throw new InvariantViolationError(`leave: session ${sessionId} is not in a group`)
    }
    const next = removeLeaf(group.tree, sessionId)
    const idx = this._groups.findIndex((g) => g.id === group.id)

    if (next === undefined) {
      // Dissolved: a 2-member group always collapses to exactly 1 other leaf.
      this._groups.splice(idx, 1)
      const remainingId = leafIds(group.tree).find((id) => id !== sessionId)
      if (remainingId !== undefined) {
        this.moveSessionAdjacentTo(sessionId, remainingId)
      }
    } else {
      this._groups[idx] = { ...group, tree: next }
      const remainingInTabOrder = this.tabOrderedLeafIds(next)
      const lastRemaining = remainingInTabOrder[remainingInTabOrder.length - 1]
      this.moveSessionAdjacentTo(sessionId, lastRemaining)
    }
  }

  /** Remove the group entirely: every member becomes lone. Tabs stay in place. */
  ungroup(groupId: GroupId): void {
    const idx = this._groups.findIndex((g) => g.id === groupId)
    if (idx === -1) {
      throw new InvariantViolationError(`ungroup: group ${groupId} not in task ${this.id}`)
    }
    this._groups.splice(idx, 1)
  }

  /**
   * Move the WHOLE group as one block, keeping members' relative order.
   * `toIndex` is the index of the block's first member in the RESULTING full
   * session order. Snapped so the block never lands inside another group (ties
   * favor the earlier/left edge; see `snapInsertionIndex`).
   */
  reorderGroup(groupId: GroupId, toIndex: number): void {
    // Same defensive guard as `reorderSession` (review m1/round-2 minor): `Task`
    // is called directly by use cases/tests, not only through IPC, so the input
    // shape must be checked here too, not just in the IPC handler.
    if (!Number.isInteger(toIndex) || toIndex < 0) {
      throw new InvariantViolationError(
        `reorderGroup: toIndex must be a non-negative integer, got ${toIndex}`
      )
    }
    const group = this._groups.find((g) => g.id === groupId)
    if (!group) {
      throw new InvariantViolationError(`reorderGroup: group ${groupId} not in task ${this.id}`)
    }
    const memberIds = new Set(this.tabOrderedLeafIds(group.tree))
    const ordered = [...this.sessions()]
    const block = ordered.filter((s) => memberIds.has(s.id))
    const rest = ordered.filter((s) => !memberIds.has(s.id))

    const clamped = Math.max(0, Math.min(toIndex, rest.length))
    const snapped = this.snapInsertionIndex(clamped, rest)

    rest.splice(snapped, 0, ...block)
    rest.forEach((s, i) => s.setOrder(i))
  }

  /** Set the ratio of one of the group's split nodes (clamped 0.1–0.9; see `group-tree.ts`). */
  resizeGroup(groupId: GroupId, path: GroupPath, ratio: number): void {
    const idx = this._groups.findIndex((g) => g.id === groupId)
    if (idx === -1) {
      throw new InvariantViolationError(`resizeGroup: group ${groupId} not in task ${this.id}`)
    }
    this._groups[idx] = {
      ...this._groups[idx],
      tree: setRatio(this._groups[idx].tree, path, ratio)
    }
  }

  /** Drop `id`'s leaf from its group, if any (dissolve at 1); used by `removeSession`. */
  private dropLeafFromGroup(id: SessionId): void {
    const group = this.groupOf(id)
    if (!group) return
    const next = removeLeaf(group.tree, id)
    const idx = this._groups.findIndex((g) => g.id === group.id)
    if (next === undefined) {
      this._groups.splice(idx, 1)
    } else {
      this._groups[idx] = { ...group, tree: next }
    }
  }

  /** `group`'s member ids, in actual tab (session-order) order rather than tree (`a`-before-`b`) order. */
  private tabOrderedLeafIds(tree: GroupTree): SessionId[] {
    const ids = new Set(leafIds(tree))
    return this.sessions()
      .filter((s) => ids.has(s.id))
      .map((s) => s.id)
  }

  /** Move `id`'s tab to immediately after `afterId`'s current tab, renumbering `order`. */
  private moveSessionAdjacentTo(id: SessionId, afterId: SessionId): void {
    const ordered = [...this.sessions()]
    const fromIdx = ordered.findIndex((s) => s.id === id)
    if (fromIdx === -1) return
    const [moved] = ordered.splice(fromIdx, 1)
    const afterIdx = ordered.findIndex((s) => s.id === afterId)
    ordered.splice(afterIdx + 1, 0, moved)
    ordered.forEach((s, i) => s.setOrder(i))
  }

  /**
   * A clamp-into-the-group's-own-span function for `reorderSession`'s member
   * case: `list` is the full order with the moving member already removed, so
   * the group's other members occupy a contiguous run in it (I "members
   * contiguous"); the member may land anywhere from just-before the first of
   * them to just-after the last, i.e. `[lo, hi+1]`.
   */
  private clampToGroupSpan(group: Group, list: readonly Session[]): (index: number) => number {
    const memberIds = new Set(this.tabOrderedLeafIds(group.tree))
    const indices = list.reduce<number[]>((acc, s, i) => {
      if (memberIds.has(s.id)) acc.push(i)
      return acc
    }, [])
    const lo = indices[0] ?? 0
    const hi = indices.length > 0 ? indices[indices.length - 1] : list.length - 1
    return (index: number) => Math.max(lo, Math.min(index, hi + 1))
  }

  /**
   * Snap an insertion index so it never splits an existing group's contiguous
   * block: if `index` would land strictly between two sessions of `list` that
   * belong to the SAME group, move to that group's nearer edge (a tie — index
   * exactly in the middle — favors the earlier/left edge). Used both for a
   * lone tab landing inside a group (`reorderSession`) and for a group block
   * landing inside ANOTHER group (`reorderGroup`, where `list` already
   * excludes the moving block, so only a foreign group can be hit).
   */
  private snapInsertionIndex(index: number, list: readonly Session[]): number {
    if (index <= 0 || index >= list.length) return index
    const before = list[index - 1]
    const after = list[index]
    const beforeGroup = this.groupOf(before.id)
    if (!beforeGroup || beforeGroup !== this.groupOf(after.id)) return index

    let start = index - 1
    while (start > 0 && this.groupOf(list[start - 1].id) === beforeGroup) start--
    let end = index
    while (end < list.length && this.groupOf(list[end].id) === beforeGroup) end++

    const distToStart = index - start
    const distToEnd = end - index
    return distToEnd < distToStart ? end : start
  }

  /**
   * The first color index (0..GROUP_COLOR_PALETTE_SIZE-1) unused among `groups`
   * (defaults to this task's current `_groups`). Also used by `restoreGroups`,
   * which passes its own in-progress `restored` list since `_groups` isn't
   * assigned yet at that point.
   */
  private nextColorIndex(groups: readonly Group[] = this._groups): number {
    const used = new Set(groups.map((g) => g.colorIndex))
    for (let i = 0; i < GROUP_COLOR_PALETTE_SIZE; i++) {
      if (!used.has(i)) return i
    }
    return groups.length % GROUP_COLOR_PALETTE_SIZE
  }

  /** Set the active session; must reference a session in this task (I10). */
  setActiveSession(id: SessionId | undefined): void {
    if (id !== undefined && !this._sessions.some((s) => s.id === id)) {
      throw new InvariantViolationError(`session ${id} not in task ${this.id} (I10)`)
    }
    this._activeSessionId = id
  }

  // ── Derived state (§3.4, I11) ────────────────────────────────────────────────

  /**
   * Derive the task's aggregate state from its sessions via the injected
   * aggregator (I11 — always derived, never assigned). In V1 every session
   * contributes `Unknown`, so this returns `TaskState.Unknown`.
   */
  deriveState(aggregator: TaskStateAggregator): TaskState {
    return aggregator.aggregate(this._sessions.map((s) => s.aggregationState()))
  }

  toSnapshot(aggregator: TaskStateAggregator): TaskSnapshot {
    return {
      id: this.id,
      name: this._name,
      worktree: this._worktree
        ? {
            path: this._worktree.path,
            branch: this._worktree.branch,
            baseRef: this._worktree.baseRef,
            managed: this._worktree.managed,
            provisionedBy: this._worktree.provisionedBy
          }
        : undefined,
      repoLess: this._repoLess,
      lifecycle: this._lifecycle,
      state: this.deriveState(aggregator),
      sessions: this.sessions().map((s) => s.toSnapshot()),
      activeSessionId: this._activeSessionId,
      position: this._position,
      createdAt: this.createdAt,
      groups: this._groups.map((g) => ({ id: g.id, tree: g.tree, colorIndex: g.colorIndex }))
    }
  }
}
