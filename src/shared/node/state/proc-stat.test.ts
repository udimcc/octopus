import { describe, it, expect } from 'vitest'
import { parseProcStat } from './proc-stat'

/**
 * Layer-2 structural parse (§9.1). The load-bearing hazard is `comm`: it is wrapped
 * in parens and may itself contain spaces AND parens, so the parse must split on the
 * LAST `)`, not the first / not on whitespace.
 */
describe('parseProcStat (§9.1)', () => {
  it('parses a plain stat line: comm, pgrp (field 5), tpgid (field 8)', () => {
    // pid=1000 comm=bash state=S ppid=900 pgrp=1000 session=1000 tty=34816 tpgid=1000
    const line = '1000 (bash) S 900 1000 1000 34816 1000 4194304 ...'
    const stat = parseProcStat(line)
    expect(stat).toEqual({ pid: 1000, comm: 'bash', pgrp: 1000, tpgid: 1000 })
  })

  it('handles a comm containing spaces and parentheses (split on the LAST paren)', () => {
    // A process literally named "my proc)(" — a naive split would corrupt every field.
    const line = '1234 (my proc)() S 1 1200 1200 0 1300 0 0 0 0 0'
    const stat = parseProcStat(line)
    expect(stat).toBeDefined()
    expect(stat?.comm).toBe('my proc)(')
    expect(stat?.pid).toBe(1234)
    expect(stat?.pgrp).toBe(1200)
    // field 8 tpgid: rest tokens after last ')': [S,1,1200,1200,0,1300,...] → idx5 = 1300
    expect(stat?.tpgid).toBe(1300)
  })

  it('reads a child-in-foreground line where tpgid differs from pgrp', () => {
    const line = '2000 (zsh) S 1 2000 2000 34816 2050 ...'
    const stat = parseProcStat(line)
    expect(stat?.pgrp).toBe(2000)
    expect(stat?.tpgid).toBe(2050)
  })

  it('returns undefined for a line with no parenthesis', () => {
    expect(parseProcStat('1000 bash S 900 1000')).toBeUndefined()
  })

  it('returns undefined when there are too few post-paren fields', () => {
    expect(parseProcStat('1000 (bash) S 900 1000')).toBeUndefined()
  })

  it('returns undefined when a needed field is non-numeric', () => {
    // tpgid slot (idx5) is garbage.
    expect(parseProcStat('1000 (bash) S 900 1000 1000 0 xx 0')).toBeUndefined()
  })
})
