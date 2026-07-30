import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateLogFile } from './state-log-file'
import type { StateTransition } from '../../ports/state-log'
import { asSessionId, asTaskId } from '../../domain/ids'
import { SessionState } from '../../domain/state'

function transition(overrides: Partial<StateTransition> = {}): StateTransition {
  return {
    at: 1000,
    sessionId: asSessionId('s1'),
    taskId: asTaskId('t1'),
    from: SessionState.Unknown,
    to: SessionState.Working,
    ...overrides
  }
}

describe('createStateLogFile (§11)', () => {
  it('appends one JSON object per line (JSONL)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopus-statelog-'))
    const path = join(dir, 'state.log')
    const log = createStateLogFile({ path })

    log.record(transition({ to: SessionState.Working }))
    log.record(transition({ at: 2000, from: SessionState.Working, to: SessionState.Idle }))

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(transition({ to: SessionState.Working }))
    expect(JSON.parse(lines[1]).to).toBe(SessionState.Idle)
  })

  it('serializes the accompanying meta', () => {
    const writes: string[] = []
    const log = createStateLogFile({ path: '/log', append: (_p, data) => writes.push(data) })

    log.record(transition({ meta: { layer: 3, confidence: 'authoritative', reason: 'stop' } }))

    expect(JSON.parse(writes[0]).meta).toEqual({
      layer: 3,
      confidence: 'authoritative',
      reason: 'stop'
    })
  })

  it('never throws on an I/O failure and reports it at most once', () => {
    const errors: unknown[] = []
    const log = createStateLogFile({
      path: '/log',
      append: () => {
        throw new Error('ENOSPC')
      },
      onError: (e) => errors.push(e)
    })

    expect(() => log.record(transition())).not.toThrow()
    expect(() => log.record(transition())).not.toThrow()
    // Warned once, not on every failing write.
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('ENOSPC')
  })
})
