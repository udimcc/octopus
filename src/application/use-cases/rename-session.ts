/**
 * `renameSession` use case (DESIGN §3.2, §6.5). Renames a session tab's title.
 * Config is untouched — the title is display metadata. Persist the session row
 * and announce the new title.
 */

import type { AppDependencies } from '../dependencies'
import type { RenameSessionInput } from '../commands'
import { locateSession } from './locate-session'
import { InvariantViolationError } from '../../domain/errors'

export function renameSession(deps: AppDependencies, input: RenameSessionInput): void {
  const located = locateSession(deps.workspace, input.sessionId)
  if (!located) {
    throw new InvariantViolationError(`session ${input.sessionId} not found`)
  }
  const { session } = located

  session.rename(input.title)
  deps.persistence.upsertSession(session.toSnapshot())
  deps.bus.publish({
    type: 'sessionRenamed',
    taskId: session.taskId,
    sessionId: input.sessionId,
    title: input.title
  })
}
