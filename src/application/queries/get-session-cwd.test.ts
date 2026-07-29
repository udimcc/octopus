import { describe, it, expect } from 'vitest'
import { getSessionCwd } from './get-session-cwd'
import { makeDeps, FakeRuntime } from '../use-cases/test-fakes'
import { asSessionId, asTaskId } from '../../domain/ids'
import type { SessionRuntimeContext } from '../../ports/session-runtime'
import type { SessionRuntime } from '../../ports/session-runtime'

/** Minimal runtime context for a bare FakeRuntime (the query never reads it). */
function ctx(sessionId: string): SessionRuntimeContext {
  return {
    taskId: asTaskId('task-1'),
    sessionId: asSessionId(sessionId),
    worktreePath: '/wt',
    cols: 80,
    rows: 24,
    env: {},
    onData: () => {},
    onExit: () => {}
  }
}

describe('getSessionCwd read-model (§6.5)', () => {
  it('returns the live runtime cwd', async () => {
    const fd = makeDeps()
    const id = asSessionId('s1')
    const rt = new FakeRuntime(ctx('s1'))
    rt.cwdValue = '/a/b/c'
    fd.deps.runtimes.set(id, rt)

    expect(await getSessionCwd(fd.deps, id)).toBe('/a/b/c')
  })

  it('returns undefined for an unknown session (no live runtime)', async () => {
    const fd = makeDeps()
    expect(await getSessionCwd(fd.deps, asSessionId('nope'))).toBeUndefined()
  })

  it('returns undefined when the runtime cannot resolve a cwd', async () => {
    const fd = makeDeps()
    const id = asSessionId('s2')
    const rt = new FakeRuntime(ctx('s2')) // cwdValue unset → undefined
    fd.deps.runtimes.set(id, rt)

    expect(await getSessionCwd(fd.deps, id)).toBeUndefined()
  })

  it('returns undefined when the runtime omits the optional currentCwd seam', async () => {
    const fd = makeDeps()
    const id = asSessionId('s3')
    // A runtime that predates the seam: no currentCwd method at all.
    const legacy: SessionRuntime = {
      start: () => Promise.resolve(),
      write: () => {},
      resize: () => {},
      stop: () => Promise.resolve(),
      dispose: () => {},
      stateEvaluator: () => null
    }
    fd.deps.runtimes.set(id, legacy)

    expect(await getSessionCwd(fd.deps, id)).toBeUndefined()
  })
})
