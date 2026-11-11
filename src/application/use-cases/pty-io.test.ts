/**
 * `resizePty` resizes the live runtime and records the size for the saved history
 * (DESIGN §6.6), so restored history replays at the width it was written at.
 */
import { describe, expect, it } from 'vitest'
import { resizePty } from './pty-io'
import { makeDeps, taskInput } from './test-fakes'
import { createTask } from './create-task'
import { openSession } from './open-session'
import { asTaskId } from '../../domain/ids'

describe('resizePty', () => {
  it('resizes the runtime and records the size for the scrollback', async () => {
    const f = makeDeps()
    await createTask(f.deps, taskInput('T'))
    const sessionId = await openSession(f.deps, { taskId: asTaskId('task-1') })
    resizePty(f.deps, { sessionId, cols: 200, rows: 50 })
    expect(f.sessions.last()!.resizes.at(-1)).toEqual({ cols: 200, rows: 50 })
    expect(f.scrollbacks.sizes.get(sessionId)).toEqual({ cols: 200, rows: 50 })
  })

  it('records nothing for a session without a runtime (a resize racing a close)', async () => {
    const f = makeDeps()
    await createTask(f.deps, taskInput('T'))
    const sessionId = await openSession(f.deps, { taskId: asTaskId('task-1') })
    f.deps.runtimes.delete(sessionId)
    f.scrollbacks.sizes.clear()
    resizePty(f.deps, { sessionId, cols: 200, rows: 50 })
    expect(f.scrollbacks.sizes.has(sessionId)).toBe(false)
  })
})
