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
      dispose: () => undefined
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

  it('daemon backend: DETACHES runtimes (dispose) instead of killing them (stop) (§6.2)', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    await openSession(fd.deps, { taskId: asTaskId('task-1') })
    await openSession(fd.deps, { taskId: asTaskId('task-1') })
    const runtimes = fd.sessions.created
    expect(fd.deps.runtimes.all()).toHaveLength(2)

    shutdown(fd.deps, { daemonBackend: true })

    // Durable backend: PTYs must survive for re-attach → dispose (detach), NOT stop.
    expect(runtimes.every((r) => r.disposed)).toBe(true)
    expect(runtimes.every((r) => r.stopped)).toBe(false)
    expect(fd.deps.runtimes.all()).toEqual([])
    expect(fd.persistence.checkpointed).toBe(true)
  })

  it('daemon backend: drops the client socket (onReleased) after detach, before checkpoint', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    await openSession(fd.deps, { taskId: asTaskId('task-1') })
    const order: string[] = []
    const runtime = fd.sessions.created[0]
    const origDispose = runtime.dispose.bind(runtime)
    runtime.dispose = () => {
      order.push('detach')
      origDispose()
    }
    const origCheckpoint = fd.persistence.checkpointAndClose.bind(fd.persistence)
    fd.persistence.checkpointAndClose = () => {
      order.push('checkpoint')
      origCheckpoint()
    }

    shutdown(fd.deps, {
      daemonBackend: true,
      onReleased: () => order.push('dropSocket')
    })

    // Ordering is load-bearing (§6.2/§6.3): detach every runtime, THEN drop the
    // socket (daemon reads disconnect as detach-all), THEN checkpoint the store.
    expect(order).toEqual(['detach', 'dropSocket', 'checkpoint'])
  })

  it('daemon backend: an onReleased that throws does not block the checkpoint', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))
    await openSession(fd.deps, { taskId: asTaskId('task-1') })

    expect(() =>
      shutdown(fd.deps, {
        daemonBackend: true,
        onReleased: () => {
          throw new Error('socket teardown boom')
        }
      })
    ).not.toThrow()
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
