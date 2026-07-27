/**
 * `sanitizeRestoredHistory` makes stale replayed scrollback safe: it removes query
 * *requests* (which elicit replies) and appends a reset of input-reporting DEC private
 * modes (focus/mouse/paste), while preserving reply forms, OSC color *set* sequences,
 * and all printable/SGR content. See the module docblock for why (I13 stale-history).
 */

import { describe, it, expect } from 'vitest'
import { sanitizeRestoredHistory } from './sanitize-restored-history'

/** The input-mode reset the helper appends; assert *content*, not this exact literal. */
const RESET = '\x1b[?1004;1000;1001;1002;1003;1005;1006;1015;1016;2004l'

/** History body with the trailing reset removed, for asserting on the stripped part. */
function body(out: string): string {
  expect(out.endsWith(RESET)).toBe(true)
  return out.slice(0, -RESET.length)
}

describe('sanitizeRestoredHistory removes query requests', () => {
  it('removes Primary DA (DA1) requests, with and without a parameter', () => {
    expect(body(sanitizeRestoredHistory('a\x1b[cb'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b[0cb'))).toBe('ab')
  })

  it('removes Secondary and Tertiary DA (DA2/DA3) requests', () => {
    expect(body(sanitizeRestoredHistory('a\x1b[>cb'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b[=cb'))).toBe('ab')
  })

  it('removes DSR / cursor-position requests, incl. DEC private form', () => {
    expect(body(sanitizeRestoredHistory('a\x1b[6nb'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b[?6nb'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b[5nb'))).toBe('ab')
  })

  it('removes XTVERSION requests', () => {
    expect(body(sanitizeRestoredHistory('a\x1b[>qb'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b[>0qb'))).toBe('ab')
  })

  it('removes DECRQM request-mode queries (ANSI and DEC private)', () => {
    expect(body(sanitizeRestoredHistory('a\x1b[?2026$pb'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b[4$pb'))).toBe('ab')
  })

  it('removes OSC color queries, BEL- and ST-terminated', () => {
    expect(body(sanitizeRestoredHistory('a\x1b]11;?\x07b'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b]10;?\x1b\\b'))).toBe('ab')
    expect(body(sanitizeRestoredHistory('a\x1b]4;1;?\x1b\\b'))).toBe('ab')
  })

  it('removes the repeating garbage-producing pattern seen on restore', () => {
    // The exact requests whose replies produced `0;276;0c` / `11;rgb:…` in the report.
    expect(body(sanitizeRestoredHistory('prompt$ \x1b[c\x1b]11;?\x07'))).toBe('prompt$ ')
  })
})

describe('sanitizeRestoredHistory resets input-reporting modes', () => {
  it('appends a reset of focus/mouse/paste modes after the history', () => {
    const out = sanitizeRestoredHistory('hello')
    expect(out).toBe('hello' + RESET)
    // Focus reporting `?1004` — the `^[[I` focus-in-report symptom — is disabled.
    expect(out).toContain('1004')
    // Bracketed paste `?2004` too.
    expect(out).toContain('2004')
    expect(out.endsWith('l')).toBe(true)
  })

  it('leaves a stale focus-enable in the body but neutralizes it with the trailing reset', () => {
    // A program enabled focus reporting last session; the enable is preserved in the
    // body (we do not rewrite mid-stream) but the appended reset turns it back off.
    const out = sanitizeRestoredHistory('\x1b[?1004hprompt$ ')
    expect(body(out)).toBe('\x1b[?1004hprompt$ ')
    expect(out.endsWith(RESET)).toBe(true)
  })
})

describe('sanitizeRestoredHistory preserves non-query content', () => {
  it('leaves plain text untouched', () => {
    expect(body(sanitizeRestoredHistory('hello world'))).toBe('hello world')
  })

  it('leaves SGR sequences untouched', () => {
    expect(body(sanitizeRestoredHistory('\x1b[1;31mred\x1b[0m'))).toBe('\x1b[1;31mred\x1b[0m')
  })

  it('leaves OSC color *set* sequences (no ?) untouched', () => {
    const set = '\x1b]11;rgb:0e0e/1111/1616\x07'
    expect(body(sanitizeRestoredHistory(set))).toBe(set)
  })

  it('leaves an OSC window-title set untouched', () => {
    expect(body(sanitizeRestoredHistory('\x1b]0;hi\x07'))).toBe('\x1b]0;hi\x07')
  })

  it('leaves DECSCUSR (CSI Ps SP q) untouched', () => {
    expect(body(sanitizeRestoredHistory('\x1b[2 q'))).toBe('\x1b[2 q')
  })

  it('leaves DA reply forms untouched (only requests are stripped)', () => {
    expect(body(sanitizeRestoredHistory('\x1b[?0;276;0c'))).toBe('\x1b[?0;276;0c')
  })
})
