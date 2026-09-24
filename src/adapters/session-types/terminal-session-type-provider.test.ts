import { describe, it, expect } from 'vitest'
import { TerminalSessionTypeProvider, TERMINAL_TYPE_ID } from './terminal-session-type-provider'
import { InMemorySessionTypeRegistry } from './session-type-registry'
import { Capability } from '../../ports/session-type-provider'
import type {
  SessionManager,
  SessionRuntime,
  SessionRuntimeContext
} from '../../ports/session-runtime'
import { asTypeId } from '../../domain/ids'

describe('TerminalSessionTypeProvider (§8, §9)', () => {
  it('is the terminal type, available from V1, and now advertises EvaluatesState (§9)', () => {
    const p = new TerminalSessionTypeProvider()
    expect(p.typeId).toBe(TERMINAL_TYPE_ID)
    expect(p.displayName).toBe('Terminal')
    expect(p.availableFromVersion).toBe(1)
    // Phase 2 flips the dormant seam on: the terminal type evaluates state (§9.6/§10).
    expect(p.capabilities.has(Capability.EvaluatesState)).toBe(true)
    expect(p.capabilities.size).toBe(1)
  })

  it('defaultConfig points cwd at the worktree', () => {
    const p = new TerminalSessionTypeProvider()
    expect(p.defaultConfig('/wt/x')).toEqual({ kind: 'terminal', cwdOverride: '/wt/x' })
  })

  it('createRuntime delegates to the injected SessionManager (behavior/rendering split)', () => {
    const p = new TerminalSessionTypeProvider()
    const ctx = {} as SessionRuntimeContext
    const runtime = {} as SessionRuntime
    let received: SessionRuntimeContext | undefined
    const manager: SessionManager = {
      createRuntime: (c) => {
        received = c
        return runtime
      }
    }
    expect(p.createRuntime(manager, ctx)).toBe(runtime)
    expect(received).toBe(ctx)
  })
})

describe('InMemorySessionTypeRegistry (§8, §5.4)', () => {
  it('registers and resolves a provider by typeId', () => {
    const reg = new InMemorySessionTypeRegistry()
    const p = new TerminalSessionTypeProvider()
    reg.register(p)
    expect(reg.get(TERMINAL_TYPE_ID)).toBe(p)
    expect(reg.get(asTypeId('missing'))).toBeUndefined()
  })

  it('available() filters by availableFromVersion ≤ version', () => {
    const reg = new InMemorySessionTypeRegistry()
    reg.register(new TerminalSessionTypeProvider())
    // A hypothetical V3 provider is hidden at V1.
    reg.register({
      typeId: asTypeId('jenkins'),
      displayName: 'Jenkins',
      icon: 'jenkins',
      availableFromVersion: 3,
      configSchema: {},
      capabilities: new Set(),
      defaultConfig: () => ({ kind: 'terminal' }),
      createRuntime: () => ({}) as SessionRuntime
    })
    expect(reg.available(1).map((p) => p.typeId)).toEqual([TERMINAL_TYPE_ID])
    expect(
      reg
        .available(3)
        .map((p) => p.typeId)
        .sort()
    ).toEqual([TERMINAL_TYPE_ID, asTypeId('jenkins')].sort())
  })
})
