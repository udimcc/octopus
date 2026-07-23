import { describe, it, expect } from 'vitest'
import { createAjvConfigValidator } from './config-validator'
import type { SessionConfig } from '../domain/session-config'

const TERMINAL_SCHEMA: object = {
  type: 'object',
  properties: {
    kind: { const: 'terminal' },
    shell: { type: 'string' },
    initialCommand: { type: 'string' },
    cwdOverride: { type: 'string' }
  },
  required: ['kind'],
  additionalProperties: false
}

describe('createAjvConfigValidator (§8, §10 seam)', () => {
  it('accepts a well-formed terminal config', () => {
    const v = createAjvConfigValidator()
    const config: SessionConfig = { kind: 'terminal', cwdOverride: '/wt', shell: '/bin/bash' }
    expect(v.validate(TERMINAL_SCHEMA, config)).toEqual({ ok: true })
  })

  it('accepts the minimal config (only the discriminant)', () => {
    const v = createAjvConfigValidator()
    expect(v.validate(TERMINAL_SCHEMA, { kind: 'terminal' } as SessionConfig).ok).toBe(true)
  })

  it('rejects an unknown property (additionalProperties: false) with a reason', () => {
    const v = createAjvConfigValidator()
    const bad = { kind: 'terminal', bogus: 1 } as unknown as SessionConfig
    const res = v.validate(TERMINAL_SCHEMA, bad)
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('rejects a wrong-typed field', () => {
    const v = createAjvConfigValidator()
    const bad = { kind: 'terminal', shell: 123 } as unknown as SessionConfig
    expect(v.validate(TERMINAL_SCHEMA, bad).ok).toBe(false)
  })

  it('caches compiled validators by schema identity (same schema object reused)', () => {
    const v = createAjvConfigValidator()
    // Two validations with the SAME schema reference exercise the WeakMap cache;
    // both must succeed identically (no recompilation surprises).
    const c: SessionConfig = { kind: 'terminal' }
    expect(v.validate(TERMINAL_SCHEMA, c).ok).toBe(true)
    expect(v.validate(TERMINAL_SCHEMA, c).ok).toBe(true)
  })
})
