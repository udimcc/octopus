import { describe, it, expect } from 'vitest'
import { toSafeExternalUrl, isSafeExternalUrl } from './external-url'

describe('toSafeExternalUrl (§13.4)', () => {
  it('accepts a bare http URL and returns its normalized href (trailing slash added)', () => {
    expect(toSafeExternalUrl('http://example.com')).toBe('http://example.com/')
  })

  it('accepts an https URL with path and query, returned unchanged (already normalized)', () => {
    expect(toSafeExternalUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('trims surrounding whitespace before validating', () => {
    expect(toSafeExternalUrl('  http://example.com  ')).toBe('http://example.com/')
  })

  it('rejects the empty string', () => {
    expect(toSafeExternalUrl('')).toBeUndefined()
  })

  it('rejects a whitespace-only string', () => {
    expect(toSafeExternalUrl('   ')).toBeUndefined()
  })

  it('rejects a malformed/unparseable URL', () => {
    expect(toSafeExternalUrl('not a url')).toBeUndefined()
  })

  it('rejects a protocol-relative URL (no scheme to allowlist, and no base to resolve against)', () => {
    expect(toSafeExternalUrl('//evil.com')).toBeUndefined()
  })

  it('m11: rejects a relative path (no scheme, no base to resolve against)', () => {
    expect(toSafeExternalUrl('/path')).toBeUndefined()
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>'])(
    'rejects the dangerous scheme in %s',
    (url) => {
      expect(toSafeExternalUrl(url)).toBeUndefined()
    }
  )

  it('rejects mailto: (not http/https, even though it is well-formed)', () => {
    expect(toSafeExternalUrl('mailto:a@b.com')).toBeUndefined()
  })

  it('is case-insensitive on the scheme (URL parsing lowercases it) and still accepts it', () => {
    expect(toSafeExternalUrl('HTTP://EXAMPLE.COM')).toBe('http://example.com/')
  })

  it('accepts and normalizes a URL carrying embedded credentials (the implementation has no opinion on userinfo — only scheme is checked)', () => {
    expect(toSafeExternalUrl('http://user:pass@example.com')).toBe('http://user:pass@example.com/')
  })
})

describe('isSafeExternalUrl (§13.4)', () => {
  it('is true for exactly the URLs toSafeExternalUrl accepts', () => {
    expect(isSafeExternalUrl('https://example.com/path?q=1')).toBe(true)
  })

  it('is false for exactly the URLs toSafeExternalUrl rejects', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})
