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
 * Builds the `SessionRuntimeContext`: cwd = config override or the worktree; env
 * = the process env the adapter sanitizes + augments with OCTOPUS_* (and the
 * dormant OCTOPUS_STATE_SOCKET, §9.2 seam); onData → `ptyData` event; onExit →
 * the late-bound `deps.onRuntimeExit` which re-enters the single-writer loop as a
 * `handleRuntimeExit` command (never mutates inline, §6.6).
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
  const cwd = configCwd(session.config) ?? worktree.path
  const ctx: SessionRuntimeContext = {
    taskId: task.id,
    sessionId: id,
    worktreePath: cwd,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    env: process.env,
    shell: configShell(session.config),
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

  // Deliver an initial command to the fresh shell, if configured (§3.2).
  const initial = configInitialCommand(session.config)
  if (initial) {
    runtime.write(initial.endsWith('\n') ? initial : initial + '\n')
  }
}
