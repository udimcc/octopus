/**
 * `IdGenerator` backed by `crypto.randomUUID` (DESIGN §2). Task and session ids
 * are globally unique v4 UUIDs (I5/I6); the branding is applied at the boundary
 * so callers get typed `TaskId`/`SessionId` values.
 */

import { randomUUID } from 'node:crypto'
import type { IdGenerator } from '../../ports/id-generator'
import { asTaskId, asSessionId, type TaskId, type SessionId } from '../../domain/ids'

export class UuidIdGenerator implements IdGenerator {
  newTaskId(): TaskId {
    return asTaskId(randomUUID())
  }

  newSessionId(): SessionId {
    return asSessionId(randomUUID())
  }
}
