/**
 * `closeWindow` use case (DESIGN §3.7, §6.7). Closes a secondary window and
 * resolves the fate of the sessions it still hosts. The renderer's OS close dialog
 * has already chosen a `disposition`:
 *
 *   - `move-to-main` — reassign every hosted session back to the main window
 *     (reusing `moveSessionToWindow`, so PTYs keep running and re-home in the main
 *     window's `TaskView`). Nothing is killed. Each move carries
 *     `cause: 'windowClosed'` so the main window keeps its existing marks.
 *   - `kill-sessions` — close every hosted session (reusing `closeSession`, the
 *     full Running→Stopping→Closed teardown + row delete).
 *
 * A window is never a domain aggregate, so "the window's sessions" is a two-level
 * scan (workspace → tasks → sessions filtered by `windowId`), mirroring
 * `locateSession`'s linear walk. After the sessions are handled, the window row is
 * deleted and `windowClosed` is emitted; `main` closes the OS `BrowserWindow` on
 * that event and the registry stops routing to it.
 *
 * The scan is snapshotted into an array BEFORE mutating, because both dispositions
 * mutate the sessions they iterate (reassign / remove).
 */

import type { AppDependencies } from '../dependencies'
import type { CloseWindowInput } from '../commands'
import type { Session } from '../../domain/session'
import { MAIN_WINDOW_ID } from '../../domain/ids'
import { moveSessionToWindow } from './move-session-to-window'
import { closeSession } from './close-session'

export async function closeWindow(deps: AppDependencies, input: CloseWindowInput): Promise<void> {
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
    for (const session of hosted) {
      // Tagged so the main window keeps its own mark per task (§6.7) rather than
      // marking each re-homed session as if the user had dragged it there.
      moveSessionToWindow(
        deps,
        { sessionId: session.id, targetWindowId: MAIN_WINDOW_ID },
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
