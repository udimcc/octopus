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
 */

import type { AppDependencies } from '../dependencies'
import type { CreateSessionInput } from '../commands'
import type { SessionConfig } from '../../domain/session-config'
import { Session } from '../../domain/session'
import { InvariantViolationError } from '../../domain/errors'
import { asTypeId, type TypeId } from '../../domain/ids'
import { startSessionRuntime } from './start-session-runtime'

export async function openSession(deps: AppDependencies, input: CreateSessionInput): Promise<void> {
  const task = deps.workspace.task(input.taskId)
  if (!task) {
    throw new InvariantViolationError(`task ${input.taskId} not found`)
  }
  const worktree = task.worktree
  if (!worktree) {
    // A session's cwd is the worktree; a task without one is not Ready (I1).
    throw new InvariantViolationError(`task ${input.taskId} has no worktree (not Ready)`)
  }

  const typeId: TypeId = input.typeId ?? asTypeId(deps.workspace.config.defaultSessionTypeId)
  const provider = deps.registry.get(typeId)
  if (!provider) {
    throw new InvariantViolationError(`unknown session type: ${typeId}`)
  }

  const config: SessionConfig = input.config ?? provider.defaultConfig(worktree.path)

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
  const order = task.sessions().length
  const title = input.title ?? defaultTitle(provider.displayName, order)

  const session = Session.create({
    id,
    taskId: input.taskId,
    typeId,
    title,
    config,
    order,
    createdAt: now
  })

  // Start the runtime (Created → Starting → Running). On failure this throws after
  // marking StartFailed + disposing; the session is never added or persisted.
  await startSessionRuntime(deps, task, session, worktree)

  task.addSession(session)

  // Persist the session definition (I15) — its config re-creates it on restart.
  deps.persistence.transaction(() => {
    deps.persistence.upsertSession(session.toSnapshot())
    // addSession may have made this the active session; persist the task too.
    deps.persistence.upsertTask(task.toSnapshot(deps.aggregator))
  })

  deps.bus.publish({ type: 'sessionCreated', taskId: input.taskId, session: session.toSnapshot() })
}

function defaultTitle(displayName: string, order: number): string {
  return `${displayName} ${order + 1}`
}
