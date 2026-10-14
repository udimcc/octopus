/**
 * `moveSessionToWindow` use case (DESIGN §3.7, §6.7, I18). Reassigns which OS
 * window renders a session. This is a PURE VIEW MOVE:
 *
 *   - The session's `taskId` never changes (I7/I18) — a session belongs to exactly
 *     one task for its whole life; only its `windowId` (opaque display tag) moves.
 *   - The runtime is UNTOUCHED. The PTY is keyed by `sessionId` in main, so the
 *     move is not a restart: no `markStopping`/`stop()`/re-`start()`, no lifecycle
 *     transition. The existing `pty-router` replay buffer carries the scrollback
 *     into the destination window's terminal.
 *
 * Persist the session row(s) (so the assignment survives restart, §6.3) and emit
 * `sessionMovedToWindow` carrying both endpoints — the registry routes it to the
 * from- and to-windows so both re-render (the source unmounts the pane, the target
 * mounts it).
 *
 * A GROUP MEMBER drags its whole group along (DESIGN §5.7 "Moving a group"): every
 * member of a group shares one window (the `join` invariant), so moving one means
 * moving all of them, together. `Task.moveToWindow` (review I2) is what enforces
 * this invariant now — not a manual `groupMembers` loop here — and it returns the
 * moved ids with `input.sessionId` FIRST, then the rest of the group in tab order
 * (`[sessionId]` for a lone session, so this subsumes the lone-session case with no
 * branching). The group's tree/color is untouched (only `windowId` per session row
 * changes), so no `session_groups` write is needed here.
 *
 * `opts.cause` (internal callers only — NOT part of the IPC command input) tags WHY
 * the DIRECTLY-SENT session (`input.sessionId`) moved: `close-window.ts` passes
 * `'windowClosed'` for its move-to-main disposition, so the main window keeps its
 * existing mark for the task instead of marking each re-homed session. Every OTHER
 * member riding along gets `cause: 'groupMove'` regardless of `opts`, so the target
 * window marks only the member the user (or caller) actually targeted — not its
 * groupmates (DESIGN §5.7 "the target marks only the member that was sent"). The
 * publish loop below relies on `moveToWindow`'s sent-first ordering to apply this
 * tag correctly without a second lookup.
 */

import type { AppDependencies } from '../dependencies'
import type { MoveSessionToWindowInput } from '../commands'
import { locateSession } from './locate-session'
import { InvariantViolationError } from '../../domain/errors'

export interface MoveSessionToWindowOptions {
  readonly cause?: 'windowClosed'
}

export function moveSessionToWindow(
  deps: AppDependencies,
  input: MoveSessionToWindowInput,
  opts?: MoveSessionToWindowOptions
): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    throw new InvariantViolationError(`session ${input.sessionId} not found`)
  }
  const { task, session } = located
  const fromWindowId = session.windowId

  // No-op if the session (and so its whole group) is already in the target
  // window (idempotent drop) — also what makes re-processing a groupmate later
  // in a caller's loop (e.g. `closeWindow`'s per-session scan) harmless.
  if (fromWindowId === input.targetWindowId) {
    return
  }

  const movedIds = task.moveToWindow(input.sessionId, input.targetWindowId)

  deps.persistence.transaction(() => {
    for (const memberId of movedIds) {
      const member = task.session(memberId)
      if (!member) continue
      deps.persistence.upsertSession(member.toSnapshot())
    }
  })

  for (const memberId of movedIds) {
    const cause = memberId === input.sessionId ? opts?.cause : 'groupMove'
    deps.bus.publish({
      type: 'sessionMovedToWindow',
      sessionId: memberId,
      taskId: session.taskId,
      fromWindowId,
      toWindowId: input.targetWindowId,
      ...(cause !== undefined ? { cause } : {})
    })
  }
}
