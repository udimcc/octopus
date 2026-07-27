import { describe, it, expect } from 'vitest'
import { shutdown } from './quit'
import { createTask } from './use-cases/create-task'
import { openSession } from './use-cases/open-session'
import { makeDeps, taskInput } from './use-cases/test-fakes'
import { asTaskId } from '../domain/ids'

describe('shutdown (§6.3 Quit, I13)', () => {
  it('stops every live runtime, clears the registry, and checkpoints the store', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    await openSession(fd.deps, { taskId: asTaskId('task-1') })
    await openSession(fd.deps, { taskId: asTaskId('task-1') })
    const runtimes = fd.sessions.created
    expect(fd.deps.runtimes.all()).toHaveLength(2)

    shutdown(fd.deps)

    expect(runtimes.every((r) => r.stopped)).toBe(true)
    expect(fd.deps.runtimes.all()).toEqual([])
    expect(fd.persistence.checkpointed).toBe(true)
  })

  it('is best-effort: a runtime stop() that throws does not block the checkpoint', () => {
    const fd = makeDeps()
    // Register a runtime whose stop throws synchronously.
    const throwing = {
      start: () => Promise.resolve(),
      write: () => undefined,
      resize: () => undefined,
      stop: () => {
        throw new Error('stop boom')
      },
      dispose: () => undefined,
      stateEvaluator: () => null
    }
    fd.deps.runtimes.set(asTaskId('x') as never, throwing as never)

    expect(() => shutdown(fd.deps)).not.toThrow()
    expect(fd.persistence.checkpointed).toBe(true)
    expect(fd.deps.runtimes.all()).toEqual([])
  })

  it('checkpoints even with no runtimes', () => {
    const fd = makeDeps()
    shutdown(fd.deps)
    expect(fd.persistence.checkpointed).toBe(true)
  })

  it('flushes every captured scrollback buffer to the store before checkpointing (§6.6)', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    await openSession(fd.deps, { taskId: asTaskId('task-1') })
    const sessionId = fd.workspace.task(asTaskId('task-1'))!.sessions()[0].id
    // Simulate accumulated output for the live session.
    fd.deps.scrollbacks.append(sessionId, 'buffered output')

    shutdown(fd.deps)

    expect(fd.persistence.savedScrollback.get(sessionId)).toBe('buffered output')
    expect(fd.persistence.checkpointed).toBe(true)
  })

  it('is best-effort: a saveScrollback that throws does not block the checkpoint', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    await openSession(fd.deps, { taskId: asTaskId('task-1') })
    const sessionId = fd.workspace.task(asTaskId('task-1'))!.sessions()[0].id
    fd.deps.scrollbacks.append(sessionId, 'x')
    fd.persistence.saveScrollback = () => {
      throw new Error('save boom')
    }

    expect(() => shutdown(fd.deps)).not.toThrow()
    expect(fd.persistence.checkpointed).toBe(true)
  })
})
