/**
 * Shared runtime-start core (DESIGN §3.6, §6.1). Drives an already-created,
 * task-owned session through `Starting → Running` by spawning its runtime, and
 * registers the live handle. Used by BOTH:
 *
 *   - `openSession` — a brand-new session the user just created; and
 *   - `startTaskSessions` — a restored session's fresh PTY, started lazily when
 *     its task first becomes visible (§6.3 "open a fresh PTY in the worktree").
 *
 * It owns ONLY the runtime lifecycle + registry + the optional initial command.
 * It does NOT add the session to the task or persist it: on a start failure the
 * caller decides whether the session is discarded (new session) or left as a
 * `StartFailed` tab (restored session). The session must already be in `Created`
 * (its transition table only allows `Created → Starting`, §3.6).
 *
 * Builds the `SessionRuntimeContext`: cwd = last-known cwd (durable backend, §6.2)
 * or config override or the worktree; env = the process env the adapter sanitizes +
 * augments with OCTOPUS_* (and the dormant OCTOPUS_STATE_SOCKET, §9.2 seam); onData
 * → `ptyData` event; onExit → the late-bound `deps.onRuntimeExit` which re-enters
 * the single-writer loop as a `handleRuntimeExit` command (never mutates inline,
 * §6.6).
 *
 * Spawn-vs-attach seam (§6.2, §10): `ctx.resume` is set when the durable backend's
 * live roster (`deps.liveDaemonSessions`) still holds this id — the runtime then
 * RE-ATTACHES to the surviving PTY rather than spawning fresh, and the initial
 * command is suppressed (the shell already exists). On the in-process backend the
 * roster is empty, so this reduces to today's always-fresh-spawn behavior exactly.
 *
 * Throws (after `markStartFailed` + dispose + an `error` event) if `start()`
 * rejects, so the caller's try/catch runs.
 */

import type { AppDependencies } from '../dependencies'
import type { Task } from '../../domain/task'
import type { Session } from '../../domain/session'
import type { SessionRuntimeContext } from '../../ports/session-runtime'
import type { WorktreeRef } from '../../domain/worktree-ref'
import { InvariantViolationError } from '../../domain/errors'
import { configCwd, configShell, configInitialCommand } from './session-config-access'

/** Default terminal size before the renderer's first fit/resize (§6.1). */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export async function startSessionRuntime(
  deps: AppDependencies,
  task: Task,
  session: Session,
  worktree: WorktreeRef
): Promise<void> {
  const provider = deps.registry.get(session.typeId)
  if (!provider) {
    throw new InvariantViolationError(`unknown session type: ${session.typeId}`)
  }

  const id = session.id

  // Durable backend (§6.2): if the daemon still holds a LIVE PTY for this session,
  // RE-ATTACH (carrying its real cwd, running program, and scrollback) instead of
  // spawning fresh. Absent/empty on the in-process backend → always a fresh spawn
  // (V1 behavior). `PtyTerminalRuntime` ignores `resume`; `DaemonSessionRuntime`
  // branches on it.
  const resume = deps.liveDaemonSessions?.has(id) ?? false

  // Placement for a FRESH spawn only: prefer the session's last-known cwd (§6.2 —
  // captured daemon-side on quit) so a daemon-less restart lands where the user
  // left off, else the config override, else the worktree root. On re-attach the
  // live process already owns its cwd, so this is skipped.
  const lastCwd = resume ? undefined : deps.persistence.loadLastCwd(id)
  const cwd = lastCwd ?? configCwd(session.config) ?? worktree.path
  const ctx: SessionRuntimeContext = {
    taskId: task.id,
    sessionId: id,
    worktreePath: cwd,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    env: process.env,
    shell: configShell(session.config),
    resume,
    // Dormant §9.2 seam: exported to the child, never bound in V1.
    stateSocketPath: deps.socketProvisioner.socketPathFor(id),
    onData: (data) => {
      // Capture output for scrollback persistence (§6.6) before publishing, so a
      // crash between the two still keeps the byte in the buffer for the next quit
      // flush. Captured text is metadata, not live state (I13).
      deps.scrollbacks.append(id, data)
      deps.bus.publish({ type: 'ptyData', sessionId: id, data })
    },
    // Spontaneous exit → routed back through the loop (single-writer, §6.6).
    onExit: (exitCode, signal) => deps.onRuntimeExit?.(id, exitCode, signal)
  }

  const runtime = provider.createRuntime(deps.sessions, ctx)

  session.markStarting()
  try {
    await runtime.start()
  } catch (err) {
    session.markStartFailed()
    runtime.dispose()
    const message = err instanceof Error ? err.message : String(err)
    deps.bus.publish({ type: 'error', taskId: task.id, sessionId: id, message })
    throw err
  }

  session.markRunning()
  deps.runtimes.set(id, runtime)

  // Deliver an initial command to the fresh shell, if configured (§3.2). Skipped on
  // a re-attach: the shell already exists (and likely already ran it), so re-running
  // would inject a spurious command into a live session (§6.2).
  const initial = configInitialCommand(session.config)
  if (initial && !resume) {
    runtime.write(initial.endsWith('\n') ? initial : initial + '\n')
  }
}
