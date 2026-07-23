/**
 * `writeToPty` / `resizePty` (DESIGN §6.1, §6.6). These touch a LIVE runtime, not
 * the domain aggregate — but they still flow through the single-writer loop so
 * their ordering relative to `closeSession`/`createSession` is preserved: you can
 * never write to a runtime that a queued close is about to dispose (§6.6).
 *
 * Both are best-effort and silent on a missing runtime: a keystroke or resize that
 * races a close/exit is simply dropped (the tab is gone). No event, no error — the
 * renderer already knows the session ended via `sessionClosed`/`sessionExited`.
 */

import type { AppDependencies } from '../dependencies'
import type { WriteToPtyInput, ResizePtyInput } from '../commands'

export function writeToPty(deps: AppDependencies, input: WriteToPtyInput): void {
  const runtime = deps.runtimes.get(input.sessionId)
  runtime?.write(input.data)
}

export function resizePty(deps: AppDependencies, input: ResizePtyInput): void {
  const runtime = deps.runtimes.get(input.sessionId)
  runtime?.resize(input.cols, input.rows)
}
