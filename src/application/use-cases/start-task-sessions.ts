/**
 * Lazy runtime start for a task's restored sessions (DESIGN §6.3 Restore, §5.3).
 * After a restart, `Workspace.hydrate` rebuilds each session as a fresh `Created`
 * definition with NO runtime (I13); this starts a PTY for every still-`Created`
 * session of a Ready task — called when the task first becomes visible so the
 * startup PTY count is bounded to what the user actually looks at (a workspace
 * with many tasks does not fork every shell at launch).
 *
 * Idempotent: a session that is already `Running` (started on a prior activation,
 * or freshly created via `openSession`) is skipped, so calling this on every
 * `switchTask` is cheap after the first activation.
 *
 * Each successfully started session re-emits `sessionCreated` (an upsert by id in
 * the renderer store) so its lifecycle flips `created → running` in the UI and its
 * output starts flowing to the already-registered terminal sink. A start failure
 * leaves the session as a `StartFailed` tab (a restored definition is kept, unlike
 * a brand-new session) and surfaces an `error` event via `startSessionRuntime`.
 */

import type { AppDependencies } from '../dependencies'
import type { TaskId } from '../../domain/ids'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import { startSessionRuntime } from './start-session-runtime'

export async function startTaskSessions(deps: AppDependencies, taskId: TaskId): Promise<void> {
  const task = deps.workspace.task(taskId)
  if (!task || task.lifecycle !== TaskLifecycle.Ready) {
    return
  }
  const worktree = task.worktree
  if (!worktree) {
    return
  }

  for (const session of task.sessions()) {
    if (session.lifecycle !== SessionLifecycle.Created) {
      continue // already Running/Exited/etc — nothing to start
    }
    try {
      await startSessionRuntime(deps, task, session, worktree)
      // Replay any persisted scrollback (§6.6) BEFORE `sessionCreated` and before
      // the fresh shell's first output: published as an ordinary `ptyData` event,
      // it lands in the renderer's pre-mount buffer and drains into the terminal
      // the instant its sink registers — history first, then a dim separator, then
      // the live prompt. `\x1b[m` clears any SGR state left dangling in the raw
      // bytes; re-appending keeps the buffer accumulating across restarts.
      const history = deps.persistence.loadScrollback(session.id)
      if (history) {
        deps.scrollbacks.append(session.id, history)
        deps.bus.publish({
          type: 'ptyData',
          sessionId: session.id,
          data: `\x1b[m${history}\r\n\x1b[2m──── session restored ────\x1b[0m\r\n`
        })
      }
      // Persist the (now Running) definition and re-announce as an upsert so the
      // store reflects the running lifecycle and wires output.
      deps.persistence.upsertSession(session.toSnapshot())
      deps.bus.publish({ type: 'sessionCreated', taskId, session: session.toSnapshot() })
    } catch {
      // startSessionRuntime already marked StartFailed, disposed, and emitted an
      // error event. Keep the restored tab; move on to the next session.
    }
  }
}
