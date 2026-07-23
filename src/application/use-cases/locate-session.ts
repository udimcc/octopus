/**
 * Internal helper: resolve a session by id alone to its owning `(task, session)`
 * pair. Several commands (`closeSession`, `renameSession`, `handleRuntimeExit`)
 * carry only a `SessionId` — a session belongs to exactly one task (I7), so a
 * linear scan over the workspace's tasks is unambiguous. Small N (tasks × tabs),
 * runs on the single writer; no index needed (§6.6).
 */

import type { Workspace } from '../../domain/workspace'
import type { Task } from '../../domain/task'
import type { Session } from '../../domain/session'
import type { SessionId } from '../../domain/ids'

export interface LocatedSession {
  readonly task: Task
  readonly session: Session
}

export function locateSession(
  workspace: Workspace,
  sessionId: SessionId
): LocatedSession | undefined {
  for (const task of workspace.tasks()) {
    const session = task.session(sessionId)
    if (session) {
      return { task, session }
    }
  }
  return undefined
}
