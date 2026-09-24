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
 * Persist the session row (so the assignment survives restart, §6.3) and emit
 * `sessionMovedToWindow` carrying both endpoints — the registry routes it to the
 * from- and to-windows so both re-render (the source unmounts the pane, the target
 * mounts it).
 */

import type { AppDependencies } from '../dependencies'
import type { MoveSessionToWindowInput } from '../commands'
import { locateSession } from './locate-session'
import { InvariantViolationError } from '../../domain/errors'

export function moveSessionToWindow(deps: AppDependencies, input: MoveSessionToWindowInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    throw new InvariantViolationError(`session ${input.sessionId} not found`)
  }
  const { session } = located
  const fromWindowId = session.windowId

  // No-op if the session is already in the target window (idempotent drop).
  if (fromWindowId === input.targetWindowId) {
    return
  }

  session.assignToWindow(input.targetWindowId)
  deps.persistence.upsertSession(session.toSnapshot())
  deps.bus.publish({
    type: 'sessionMovedToWindow',
    sessionId: input.sessionId,
    taskId: session.taskId,
    fromWindowId,
    toWindowId: input.targetWindowId
  })
}
