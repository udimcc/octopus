import { describe, it, expect, vi } from 'vitest'
import { refreshSessionState } from './refresh-session-state'
import { makeDeps } from './test-fakes'
import { asSessionId } from '../../domain/ids'

describe('refreshSessionState (§5.4 R1, §9.6)', () => {
  it('asks the Claude state watcher to re-read this session (rescan)', () => {
    const { deps } = makeDeps()
    const refreshClaudeState = vi.fn()
    deps.refreshClaudeState = refreshClaudeState
    const sessionId = asSessionId('s1')

    refreshSessionState(deps, { sessionId })

    expect(refreshClaudeState).toHaveBeenCalledTimes(1)
    expect(refreshClaudeState).toHaveBeenCalledWith(sessionId)
  })

  it('is a no-op when no watcher sink is wired (detection opted out)', () => {
    const { deps } = makeDeps() // refreshClaudeState left undefined
    expect(() => refreshSessionState(deps, { sessionId: asSessionId('s1') })).not.toThrow()
  })
})
