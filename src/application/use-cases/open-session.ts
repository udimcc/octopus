/**
 * `openSession` use case (DESIGN §3.6, §6.1, §8). Creates a NEW session in a Ready
 * task and starts its runtime.
 *
 * Sequence (§3.6): resolve the type provider → resolve config (given, else the
 * provider's `defaultConfig(worktree)`) → validate config against the type's
 * schema (§10 seam) → `Session.create` (Created) → `startSessionRuntime`
 * (Starting → spawn → Running, shared with lazy restore) → `task.addSession` →
 * persist → emit `sessionCreated`.
 *
 * On a validation failure the session is never created (rejected pre-create). On
 * a runtime start failure `startSessionRuntime` marks it `StartFailed`, disposes,
 * and rethrows: a brand-new session that never ran is not added to the task or
 * persisted (a session that never ran is not a durable definition). Both surface
 * an `error` event.
 *
 * `input.split` (DESIGN §5.7, the split shortcut / tab-menu "Split right|down")
 * joins the new session into `anchorSessionId`'s group — forming one if the
 * anchor is lone — in this SAME command, right after `task.addSession`. The
 * anchor is validated BEFORE anything is mutated (session created, added, or
 * started): if it no longer resolves to a session of this task in the new
 * session's window (unknown id, another task, another window — all races
 * between the renderer reading its mark and this command landing), the split is
 * silently dropped and the session is created lone — losing the user's new
 * terminal entirely would be worse than losing just the split. `task.join`
 * reorders the new session's tab next to the anchor's, so that case persists
 * every session row (like `joinGroup`) instead of only the new one, and
 * publishes `groupsChanged` + `sessionReordered` after the existing
 * `sessionCreated` so the mark/focus behavior the renderer already drives off
 * `sessionCreated` is untouched.
 *
 * **View-group refusal (window-view feature).** Resolves the target window
 * (`input.windowId ?? MAIN_WINDOW_ID`) and its window-GROUP root
 * (`windowGroupRoot`), then refuses (throws, same as every other guard here) in
 * either direction a session could land in the wrong group:
 *   - T already has a dedicated view, but the target's group root is NOT that
 *     view — main (or any other window) cannot open a session for a viewed task;
 *     only that view's own group may.
 *   - The target's group root IS some view, but that view is pinned to a
 *     DIFFERENT task — a view group may only open sessions for its own task.
 * Checked before any resolution of the session type / config / worktree below,
 * so a refusal never creates partial state.
 */

import type { AppDependencies } from '../dependencies'
import type { CreateSessionInput } from '../commands'
import type { SessionConfig } from '../../domain/session-config'
import type { Group } from '../../domain/task'
import { Session } from '../../domain/session'
import { InvariantViolationError } from '../../domain/errors'
import { asTypeId, MAIN_WINDOW_ID, type TypeId } from '../../domain/ids'
import { startSessionRuntime } from './start-session-runtime'
import { persistGroups } from './persist-groups'
import { windowGroupRoot, viewForTask } from './window-groups'

export async function openSession(deps: AppDependencies, input: CreateSessionInput): Promise<void> {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }

  const windowId = input.windowId ?? MAIN_WINDOW_ID
  const windows = deps.persistence.loadWindows()
  const targetRoot = windowGroupRoot(windows, windowId)
  const view = viewForTask(windows, input.taskId)
  if (view && targetRoot !== view.id) {
    throw new InvariantViolationError(
      `task ${input.taskId} has a dedicated view window; sessions can only be opened from it`
    )
  }
  const targetRootRecord = windows.find((w) => w.id === targetRoot)
  if (targetRootRecord?.role === 'view' && targetRootRecord.taskId !== input.taskId) {
    throw new InvariantViolationError(
      `window ${windowId} belongs to another task's view; it cannot open a session for task ${input.taskId}`
    )
  }

  const worktree = task.worktree
  if (!worktree && !task.repoLess) {
    // A session's cwd is the worktree; a task without one is not Ready (I1') —
    // unless it is a "No Repo" task, whose sessions open at the home dir (§5.4).
    throw new InvariantViolationError(`task ${input.taskId} has no worktree (not Ready)`)
  }

  const typeId: TypeId = input.typeId ?? asTypeId(deps.workspace.config.defaultSessionTypeId)
  const provider = deps.registry.get(typeId)
  if (!provider) {
    throw new InvariantViolationError(`unknown session type: ${typeId}`)
  }

  // Repo-less task → no worktree path, so `defaultConfig` yields no `cwdOverride`
  // and the runtime falls back to the home dir (§5.4).
  const config: SessionConfig = input.config ?? provider.defaultConfig(worktree?.path)

  const validation = deps.configValidator.validate(provider.configSchema, config)
  if (!validation.ok) {
    // No session object exists yet; surface the failure and stop. (§3.6's
    // CreateFailed models a created-then-invalid session; here we reject pre-create.)
    deps.bus.publish({
      type: 'error',
      taskId: input.taskId,
      message: `invalid session config: ${validation.error}`
    })
    throw new InvariantViolationError(`invalid session config: ${validation.error}`)
  }

  const id = deps.ids.newSessionId()
  const now = deps.clock.now()
  // This is just the `Session`'s construction-time placeholder (the constructor
  // requires an `order`): `task.addSession` below always re-stamps it to the
  // task's actual tail position (`max(order)+1`, review C1), so a stale/removed
  // session's gap in the existing order never collides with this value. Kept as
  // `task.sessions().length` rather than e.g. `0` only because it still reads
  // naturally as "roughly last" until that overwrite happens.
  const order = task.sessions().length
  const title = input.title ?? defaultTitle(provider.displayName, task.sessions())

  const session = Session.create({
    id,
    taskId: input.taskId,
    typeId,
    title,
    config,
    order,
    createdAt: now
  })

  // Host the session in the window that requested it (V1.5, §6.7; `windowId`
  // resolved + guarded above). Stamped before toSnapshot() so the assignment is
  // persisted and carried on `sessionCreated`.
  session.assignToWindow(windowId)

  // Validate the split's anchor BEFORE any mutation (session create/add/start),
  // so a losing race degrades to a lone create rather than leaving partial group
  // state (DESIGN §5.7). `task.session` is scoped to THIS task, so an anchor from
  // another task also fails here.
  const anchor = input.split ? task.session(input.split.anchorSessionId) : undefined
  const canJoin = anchor !== undefined && anchor.windowId === windowId

  // Start the runtime (Created → Starting → Running). On failure this throws after
  // marking StartFailed + disposing; the session is never added or persisted.
  await startSessionRuntime(deps, task, session, worktree)

  task.addSession(session)

  let groupsBefore: readonly Group[] = []
  let groupsAfter: readonly Group[] = []
  let joined = false
  if (input.split && canJoin && anchor) {
    groupsBefore = task.groups()
    task.join(session.id, anchor.id, input.split.dir, deps.ids.newGroupId())
    groupsAfter = task.groups()
    joined = true
  }

  // A join reorders the new session's tab next to the anchor's, so every
  // session's (possibly renumbered) `order` must be persisted — same as
  // `joinGroup`. Without a split only the new row needs writing.
  const ordered = joined ? task.sessions() : [session]

  deps.persistence.transaction(() => {
    for (const s of ordered) {
      deps.persistence.upsertSession(s.toSnapshot())
    }
    // addSession may have made this the active session; persist the task too.
    deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
    if (joined) {
      persistGroups(deps.persistence, task.id, groupsBefore, groupsAfter)
    }
  })

  deps.bus.publish({ type: 'sessionCreated', taskId: input.taskId, session: session.toSnapshot() })
  if (joined) {
    deps.bus.publish({ type: 'groupsChanged', taskId: task.id, groups: groupsAfter })
    deps.bus.publish({
      type: 'sessionReordered',
      taskId: task.id,
      orderedSessionIds: ordered.map((s) => s.id)
    })
  }
}

/**
 * Auto-name a new session `${displayName} N`. N is `max(existing N) + 1` over the
 * task's current sessions of this display name — NOT `count + 1`. Deriving it from
 * the live count reused a number after a close: open "Terminal 1"/"Terminal 2",
 * close "Terminal 1", and the next `count + 1` was "Terminal 2" again (duplicate).
 * Scanning the highest suffix in use means a number is only reused when the highest
 * was closed — never a live collision. `order` still drives tab position separately.
 */
function defaultTitle(displayName: string, siblings: readonly { title: string }[]): string {
  // Match titles this provider auto-generates: `<displayName> <digits>`.
  const pattern = new RegExp(`^${escapeRegExp(displayName)} (\\d+)$`)
  let maxN = 0
  for (const s of siblings) {
    const m = pattern.exec(s.title)
    if (m) {
      const n = Number(m[1])
      if (n > maxN) maxN = n
    }
  }
  return `${displayName} ${maxN + 1}`
}

/** Escape a string for literal use inside a `RegExp` (displayName is provider-supplied). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
