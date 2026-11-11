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
import type { TaskId, SessionId } from '../../domain/ids'
import { TaskLifecycle, SessionLifecycle } from '../../domain/lifecycle'
import { startSessionRuntime } from './start-session-runtime'
import { RESTORED_HISTORY_END, sanitizeRestoredHistory } from './sanitize-restored-history'
import { splitLegacyScrollback } from './split-legacy-scrollback'

export async function startTaskSessions(deps: AppDependencies, taskId: TaskId): Promise<void> {
  const task = deps.workspace.task(taskId)
  if (!task || task.lifecycle !== TaskLifecycle.Ready) {
    return
  }
  // A Ready task has a worktree UNLESS it is a "No Repo" task (I1'), whose restored
  // sessions re-open at the home dir. Bail only if it is worktree-less AND not
  // repo-less (an inconsistent state that should never occur).
  const worktree = task.worktree
  if (!worktree && !task.repoLess) {
    return
  }

  for (const session of task.sessions()) {
    if (session.lifecycle !== SessionLifecycle.Created) {
      continue // already Running/Exited/etc — nothing to start
    }
    // Durable backend re-attach (§6.2): the daemon still holds this session's live
    // PTY and replays its ring buffer on attach. The in-process backend has an empty
    // roster, so this is false for every session there (always a fresh spawn).
    const willResume = deps.liveDaemonSessions?.has(session.id) ?? false
    // Persisted scrollback (§6.6) is split at the last fresh spawn: frozen `history`
    // (before it) and `live` (since it — exactly what the daemon replays). Only the
    // frozen part is ever painted from the DB, so a re-attach never double-prints,
    // and main's buffer only ever holds live output, so a save never overwrites the
    // history.
    //   - Fresh spawn: the old live part is history now. Rotate (fold it in, clear
    //     live) BEFORE the spawn, synchronously, so no flush can interleave and the
    //     new live part starts empty like the new PTY.
    //   - Re-attach: paint the frozen part; the replay that follows fills main's
    //     buffer with the live part.
    // History paints BEFORE the spawn/attach, so it lands in the renderer's pre-mount
    // buffer ahead of the live output (history is metadata, I13, independent of the
    // PTY — it is shown even if the start fails). `\x1b[m` clears SGR state left
    // dangling in the raw bytes; `sanitizeRestoredHistory` strips one-shot query
    // requests (whose replies would echo as garbage like `0;276;0c`) and resets
    // input-reporting DEC modes (focus `?1004`, mouse, bracketed paste) so a mode
    // left enabled by the old bytes can't emit input into the live PTY.
    const saved = willResume ? deps.persistence.loadScrollback(session.id) : undefined
    const history = willResume
      ? (saved?.history ?? '')
      : deps.persistence.rotateScrollback(session.id)
    if (!willResume) {
      deps.scrollbacks.delete(session.id) // nothing pre-spawn may count as live output
    }
    if (history) {
      publishHistory(deps, session.id, history)
    }
    try {
      await startSessionRuntime(deps, task, session, worktree)
      // A legacy (pre-v13) row mixes history and live output: split it once, now
      // that the replay is in main's buffer (it shows from the next restart on).
      if (saved && saved.history === null) {
        splitLegacyRow(deps, session.id, saved.live)
      }
      // Persist the (now Running) definition and re-announce as an upsert so the
      // store reflects the running lifecycle and wires output.
      deps.persistence.upsertSession(session.toSnapshot())
      deps.bus.publish({ type: 'sessionCreated', taskId, session: session.toSnapshot() })
    } catch {
      // startSessionRuntime already marked StartFailed, disposed, and emitted an
      // error event. A failed RE-ATTACH (the PTY died after the roster query) got no
      // replay, so show the saved live part too rather than a blank pane; the next
      // boot fresh-spawns and rotates it into history. Move on to the next session.
      // Drop any replay that did arrive before the failure: a later flush would save
      // it over the stored live part (and over an unsplit legacy row's history).
      deps.scrollbacks.delete(session.id)
      if (saved?.live) {
        publishHistory(deps, session.id, saved.live)
      }
    }
  }
}

/**
 * Paint restored (stale) output into the session's terminal, then a dim separator. The
 * end marker lets the pane put the separator below the old content, wherever a killed
 * TUI left the cursor.
 */
function publishHistory(deps: AppDependencies, sessionId: SessionId, history: string): void {
  deps.bus.publish({
    type: 'ptyData',
    sessionId,
    data: `\x1b[m${sanitizeRestoredHistory(history)}${RESTORED_HISTORY_END}\r\n\x1b[2m──── session restored ────\x1b[0m\r\n`
  })
}

function splitLegacyRow(deps: AppDependencies, sessionId: SessionId, savedLive: string): void {
  try {
    const replay = deps.scrollbacks.snapshot(sessionId) ?? ''
    deps.persistence.setScrollbackHistory(sessionId, splitLegacyScrollback(savedLive, replay))
  } catch {
    // Best-effort: the row stays legacy and is split on the next re-attach (or folded
    // whole into history by the next fresh spawn).
  }
}
