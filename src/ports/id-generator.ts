/**
 * Port for generating unique ids (DESIGN §2 — a volatile edge behind an
 * interface). The composition root binds a concrete generator (crypto.randomUUID)
 * so the application/domain stay pure and tests can inject deterministic ids.
 */

import type { TaskId, SessionId, WindowId } from '../domain/ids'

export interface IdGenerator {
  /** A fresh globally-unique task id (I6). */
  newTaskId(): TaskId
  /** A fresh globally-unique session id (I5). */
  newSessionId(): SessionId
  /** A fresh globally-unique window id (V1.5, §3.7). */
  newWindowId(): WindowId
}
