/**
 * `closeView` use case (window-view feature, DESIGN §3.7/§6.7 pattern). Reverses
 * `createView`: closes a task's dedicated view window, returning its sessions to
 * main and letting main auto-switch back to the task.
 *
 * Order:
 *   1. Close every secondary PARENTED to this view FIRST, each via `closeWindow`
 *      with `disposition: 'move-to-main'`. `closeWindow`'s own `move-to-main` now
 *      targets `windowGroupRoot(secondary.id)` (`close-window.ts`), which —
 *      being parented to THIS view — resolves to the view itself, so each
 *      secondary's sessions land back in the VIEW, not main, mirroring exactly
 *      how closing a plain secondary of main lands its sessions back in main.
 *   2. Move every session STILL hosted directly in the view window to
 *      `MAIN_WINDOW_ID`, tagged `cause: 'windowClosed'` — same tagging
 *      `closeWindow`'s own `move-to-main` disposition uses, so main keeps its
 *      existing mark for the task rather than re-marking on each returning
 *      session.
 *   3. Delete the view's window row, publish `windowClosed`, then `viewClosed` —
 *      BEFORE `switchTask` below publishes `activeTaskChanged`, so a listener
 *      (e.g. the renderer deciding whether to keep showing the "shown in its own
 *      window" empty state) always learns the view is gone before main's active
 *      task flips.
 *   4. `switchTask` to T, reusing the existing use case, so main auto-switches to
 *      the now-returned task (and lazily starts any of its still-`Created`
 *      sessions, same as any other switch).
 *
 * Called by the command loop for the `closeView` command and for a `closeWindow`
 * command that targets a view's id (the loop routes it here; `closeWindow` itself
 * never handles a view).
 */

import type { AppDependencies } from '../dependencies'
import type { CloseViewInput, CommandResult } from '../commands'
import type { Session } from '../../domain/session'
import { MAIN_WINDOW_ID } from '../../domain/ids'
import { closeWindow } from './close-window'
import { moveSessionToWindow } from './move-session-to-window'
import { switchTask } from './switch-task'
import { secondariesOf } from './window-groups'

export async function closeView(
  deps: AppDependencies,
  input: CloseViewInput
): Promise<CommandResult> {
  const windows = deps.persistence.loadWindows()
  const view = windows.find((w) => w.id === input.windowId)
  if (!view || view.role !== 'view' || view.taskId === undefined) {
    return { ok: false, error: `window ${input.windowId} is not a view` }
  }
  const taskId = view.taskId

  // Step 1: the view's OWN secondaries close first — their sessions land back
  // in the view itself (close-window's windowGroupRoot-aware move-to-main).
  const secondaries = secondariesOf(windows, view.id)
  for (const secondary of secondaries) {
    await closeWindow(deps, { windowId: secondary.id, disposition: 'move-to-main' })
  }

  // Step 2: whatever remains directly in the view (its own sessions, plus any
  // just moved back into it from step 1) returns to main.
  const hosted: Session[] = []
  for (const task of deps.workspace.tasks()) {
    for (const session of task.sessions()) {
      if (session.windowId === view.id) {
        hosted.push(session)
      }
    }
  }
  for (const session of hosted) {
    moveSessionToWindow(
      deps,
      { sessionId: session.id, targetWindowId: MAIN_WINDOW_ID },
      { cause: 'windowClosed' }
    )
  }

  // Step 3: the view itself is gone.
  deps.persistence.deleteWindow(view.id)
  deps.bus.publish({ type: 'windowClosed', windowId: view.id })
  deps.bus.publish({ type: 'viewClosed', windowId: view.id, taskId })

  // Step 4: main auto-switches to the returning task. Defensive: the task
  // should always still exist here (deleting a task with a view closes the
  // view itself — `delete-task.ts` — rather than ever reaching this use case
  // with the task already gone), but a vanished task is a no-op, not a throw.
  if (deps.workspace.task(taskId)) {
    await switchTask(deps, { taskId })
  }

  return { ok: true }
}
