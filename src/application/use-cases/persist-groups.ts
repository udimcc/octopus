/**
 * Shared group-persistence helper (DESIGN §5.7). Every group-mutating use case —
 * `openSession`'s `split` intent, `joinGroup`, `leaveGroup`, `ungroup`,
 * `resizeGroup`, and `closeSession` (when the closed session was grouped) — reads
 * a task's group list BEFORE and AFTER mutating it via `Task`, then calls this to
 * make persistence match: `upsertGroup` for every group present after (cheaper to
 * always upsert the survivors than diff tree/color field by field) and
 * `deleteGroup` for every group id that was present before but is gone after
 * (ungroup, dissolve-at-1, …). `moveSessionToWindow` / `createWindowWithSession` /
 * `closeWindow` do NOT call this: a pure window move only changes each member's
 * `windowId` column, never the group's own tree/color, so there is no group row
 * to persist. `reorderGroup` likewise skips it: it renumbers session `order` only,
 * leaving the group's tree/color untouched.
 *
 * `Group` (domain, `task.ts`) and `GroupSnapshot` (`domain/snapshots.ts`) are
 * structurally identical (`{ id, tree, colorIndex }`), so `Task.groups()` can be
 * passed directly as either parameter with no mapping step.
 *
 * Does NOT open its own transaction — callers that also persist session rows in
 * the same mutation (join/leave's order change) wrap both in one
 * `deps.persistence.transaction(...)`, same as `reorder-session.ts`.
 */

import type { TaskId } from '../../domain/ids'
import type { GroupSnapshot } from '../../domain/snapshots'
import type { WorkspacePersistence } from '../../ports/workspace-persistence'

export function persistGroups(
  persistence: WorkspacePersistence,
  taskId: TaskId,
  before: readonly GroupSnapshot[],
  after: readonly GroupSnapshot[]
): void {
  for (const group of after) {
    persistence.upsertGroup(taskId, group)
  }
  const afterIds = new Set(after.map((g) => g.id))
  for (const group of before) {
    if (!afterIds.has(group.id)) {
      persistence.deleteGroup(group.id)
    }
  }
}
