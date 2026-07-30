import { describe, it, expect, vi } from 'vitest'
import { refreshSessionState } from './refresh-session-state'
import { makeDeps, FakeRuntime } from './test-fakes'
import { asSessionId } from '../../domain/ids'
import type { SessionRuntimeContext, StateEvaluator } from '../../ports/session-runtime'

/** Minimal runtime context; refreshSessionState never reads its fields. */
const ctx = {} as SessionRuntimeContext

describe('refreshSessionState (§5.4 R1)', () => {
  it("nudges the live runtime's evaluator refresh()", () => {
    const { deps } = makeDeps()
    const refresh = vi.fn()
    const evaluator: StateEvaluator = { onStateChange: vi.fn(), refresh, dispose: vi.fn() }
    const runtime = new FakeRuntime(ctx)
    runtime.evaluator = evaluator
    const sessionId = asSessionId('s1')
    deps.runtimes.set(sessionId, runtime)

    refreshSessionState(deps, { sessionId })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a session with no live runtime', () => {
    const { deps } = makeDeps()
    expect(() => refreshSessionState(deps, { sessionId: asSessionId('ghost') })).not.toThrow()
  })

  it('is a no-op when the runtime has no state evaluator', () => {
    const { deps } = makeDeps()
    const runtime = new FakeRuntime(ctx) // evaluator defaults to null
    const sessionId = asSessionId('s1')
    deps.runtimes.set(sessionId, runtime)
    expect(() => refreshSessionState(deps, { sessionId })).not.toThrow()
  })

  it('is a no-op when the evaluator omits the optional refresh()', () => {
    const { deps } = makeDeps()
    const runtime = new FakeRuntime(ctx)
    runtime.evaluator = { onStateChange: vi.fn(), dispose: vi.fn() } // no refresh
    const sessionId = asSessionId('s1')
    deps.runtimes.set(sessionId, runtime)
    expect(() => refreshSessionState(deps, { sessionId })).not.toThrow()
  })
})
