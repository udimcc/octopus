/**
 * `closeWindow` use case (DESIGN §3.7, §6.7). Closes a window and resolves the
 * fate of the sessions it still hosts. The renderer's OS close dialog has
 * already chosen a `disposition`:
 *
 *   - `move-to-main` — reassign every hosted session back to the window's
 *     window-GROUP ROOT (`windowGroupRoot`, window-view feature): `MAIN_WINDOW_ID`
 *     for a plain secondary, or the parent VIEW's id for one of a view's own
 *     secondaries — reusing `moveSessionToWindow`, so PTYs keep running and
 *     re-home in the target's `TaskView`. Nothing is killed. Each move carries
 *     `cause: 'windowClosed'` so the target keeps its existing marks. All of a
 *     group's members are hosted in the same window by invariant (§5.7), so this
 *     loop's `moveSessionToWindow` call for the first member it reaches already
 *     drags the rest of that group to the target together (keeping the group
 *     intact, tagged `cause: 'groupMove'`); when the loop later reaches those
 *     groupmates, `moveSessionToWindow`'s idempotent same-window guard makes the
 *     call a no-op, so no duplicate events are published and no extra code is
 *     needed here.
 *   - `kill-sessions` — close every hosted session (reusing `closeSession`, the
 *     full Running→Stopping→Closed teardown + row delete). `closeSession` itself
 *     persists the group diff and publishes `groupsChanged` when removing a
 *     session drops a leaf, so a killed group's members (also all hosted here by
 *     invariant) dissolve/empty its group correctly without special-casing here.
 *
 * A window is never a domain aggregate, so "the window's sessions" is a two-level
 * scan (workspace → tasks → sessions filtered by `windowId`), mirroring
 * `locateSession`'s linear walk. After the sessions are handled, the window row is
 * deleted and `windowClosed` is emitted; `main` closes the OS `BrowserWindow` on
 * that event and the registry stops routing to it.
 *
 * The scan is snapshotted into an array BEFORE mutating, because both dispositions
 * mutate the sessions they iterate (reassign / remove).
 *
 * **Never main; never a view (window-view feature).** Closing the MAIN window is
 * the quit path (`window.ts`'s `wireCloseSemantics`), never this command — refused
 * below. A VIEW's own close is a richer teardown than this one (its secondaries
 * close first, THEN its sessions go to main, THEN main auto-switches to the task)
 * — `closeView`'s job. Routing a view's id to `closeView` instead is the COMMAND
 * LOOP's job (`command-loop.ts`'s `closeWindow` case), not this use case's: having
 * it delegate here would make `close-window.ts` and `close-view.ts` import each
 * other (close-view.ts already imports `closeWindow` for its secondaries' cascade).
 */

import type { AppDependencies } from '../dependencies'
import type { CloseWindowInput } from '../commands'
import type { Session } from '../../domain/session'
import { MAIN_WINDOW_ID } from '../../domain/ids'
import { InvariantViolationError } from '../../domain/errors'
import { moveSessionToWindow } from './move-session-to-window'
import { closeSession } from './close-session'
import { windowGroupRoot } from './window-groups'

export async function closeWindow(deps: AppDependencies, input: CloseWindowInput): Promise<void> {
  if (input.windowId === MAIN_WINDOW_ID) {
    throw new InvariantViolationError('cannot close the main window via closeWindow; quit instead')
  }

  const windows = deps.persistence.loadWindows()

  // Two-level scan: collect this window's sessions up front (both dispositions
  // mutate as they go, so iterating a live view would skip entries).
  const hosted: Session[] = []
  for (const task of deps.workspace.tasks()) {
    for (const session of task.sessions()) {
      if (session.windowId === input.windowId) {
        hosted.push(session)
      }
    }
  }

  if (input.disposition === 'move-to-main') {
    const target = windowGroupRoot(windows, input.windowId)
    for (const session of hosted) {
      // Tagged so the target keeps its own mark per task (§6.7) rather than
      // marking each re-homed session as if the user had dragged it there.
      moveSessionToWindow(
        deps,
        { sessionId: session.id, targetWindowId: target },
        { cause: 'windowClosed' }
      )
    }
  } else {
    for (const session of hosted) {
      await closeSession(deps, { sessionId: session.id })
    }
  }

  deps.persistence.deleteWindow(input.windowId)
  deps.bus.publish({ type: 'windowClosed', windowId: input.windowId })
}
