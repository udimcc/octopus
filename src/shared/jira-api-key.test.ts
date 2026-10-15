import { describe, it, expect } from 'vitest'
import { isPrintableAsciiKey } from './jira-api-key'

describe('isPrintableAsciiKey (DESIGN §13.7, I1)', () => {
  it.each(['sk-abc123', 'ANTHROPIC_API_KEY-xyz', '!"#$%&', '~'])(
    'accepts %s — printable ASCII, no whitespace',
    (key) => {
      expect(isPrintableAsciiKey(key)).toBe(true)
    }
  )

  it('rejects the empty string', () => {
    expect(isPrintableAsciiKey('')).toBe(false)
  })

  it('rejects a key containing a space', () => {
    expect(isPrintableAsciiKey('sk abc123')).toBe(false)
  })

  it('rejects a key containing a newline', () => {
    expect(isPrintableAsciiKey('sk-abc\n123')).toBe(false)
  })

  it('rejects a key containing a tab', () => {
    expect(isPrintableAsciiKey('sk-abc\t123')).toBe(false)
  })

  it('rejects a key containing a control byte (0x01)', () => {
    expect(isPrintableAsciiKey('sk-abc\x01123')).toBe(false)
  })

  it('rejects a key containing non-ASCII text (e.g. a pasted em dash)', () => {
    expect(isPrintableAsciiKey('sk-abc—123')).toBe(false)
  })

  it('rejects a key with leading or trailing whitespace', () => {
    expect(isPrintableAsciiKey(' sk-abc123')).toBe(false)
    expect(isPrintableAsciiKey('sk-abc123 ')).toBe(false)
  })
})
