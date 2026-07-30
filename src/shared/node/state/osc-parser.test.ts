import { describe, it, expect } from 'vitest'
import { OscParser, decodeOsc, parseStateJson } from './osc-parser'

const ESC = '\x1b'
const BEL = '\x07'
const ST = ESC + '\\'

/** Build an OSC sequence with a BEL terminator. */
const osc = (body: string): string => `${ESC}]${body}${BEL}`

describe('OscParser streaming (§9.1)', () => {
  it('decodes OSC 133 A/B/C/D marks with a BEL terminator', () => {
    const p = new OscParser()
    const out = p.push(osc('133;A') + osc('133;C') + osc('133;D;0'))
    expect(out.map((s) => (s.kind === 'osc133' ? s.mark : '?'))).toEqual(['A', 'C', 'D'])
    const d = out[2]
    expect(d.kind === 'osc133' && d.exitCode).toBe(0)
  })

  it('accepts an ST (ESC \\) terminator as well as BEL', () => {
    const p = new OscParser()
    const out = p.push(`${ESC}]133;C${ST}`)
    expect(out).toHaveLength(1)
    expect(out[0].kind === 'osc133' && out[0].mark).toBe('C')
  })

  it('reassembles a sequence split across chunks', () => {
    const p = new OscParser()
    expect(p.push(`${ESC}]133`)).toEqual([])
    expect(p.push(';')).toEqual([])
    const out = p.push(`C${BEL}`)
    expect(out).toHaveLength(1)
    expect(out[0].kind === 'osc133' && out[0].mark).toBe('C')
  })

  it('decodes an OSC 9000 explicit-state payload', () => {
    const p = new OscParser()
    const out = p.push(osc('9000;{"state":"blocked","reason":"perm"}'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'osc9000', state: 'blocked', reason: 'perm' })
  })

  it('passes plain text and CSI sequences through without emitting', () => {
    const p = new OscParser()
    const out = p.push(`hello ${ESC}[31mred${ESC}[0m world\n`)
    expect(out).toEqual([])
  })

  it('drops an unterminated oversized sequence and resyncs (cap guard, §11)', () => {
    const p = new OscParser()
    // Open an OSC and never terminate it; feed > MAX_OSC_BYTES (4096).
    p.push(`${ESC}]133;`)
    expect(p.push('x'.repeat(5000))).toEqual([])
    // After the cap reset, a fresh complete sequence still parses.
    const out = p.push(osc('133;A'))
    expect(out.map((s) => (s.kind === 'osc133' ? s.mark : '?'))).toEqual(['A'])
  })
})

describe('decodeOsc payload grammar', () => {
  it('ignores an unknown OSC number', () => {
    expect(decodeOsc('0;some title')).toBeUndefined()
  })

  it('ignores a malformed OSC 133 mark letter', () => {
    expect(decodeOsc('133;Z')).toBeUndefined()
  })
})

describe('parseStateJson validation (§9.2)', () => {
  it('accepts a known state and reads reason/tool strings', () => {
    expect(parseStateJson('{"state":"working","reason":"tool","tool":"Bash"}')).toMatchObject({
      kind: 'osc9000',
      state: 'working',
      reason: 'tool',
      tool: 'Bash'
    })
  })

  it('rejects an unknown state value', () => {
    expect(parseStateJson('{"state":"thinking"}')).toBeUndefined()
  })

  it('rejects invalid JSON', () => {
    expect(parseStateJson('{not json')).toBeUndefined()
  })

  it('rejects a non-object payload', () => {
    expect(parseStateJson('"working"')).toBeUndefined()
    expect(parseStateJson('42')).toBeUndefined()
  })

  it('rejects a payload larger than 1 KB (the ≤1 KB rule)', () => {
    const big = `{"state":"working","reason":"${'a'.repeat(1100)}"}`
    expect(parseStateJson(big)).toBeUndefined()
  })
})
