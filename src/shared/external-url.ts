/**
 * Scheme allowlist for opening a URL outside the app ("Issues", §13.4): markdown
 * description links (`IssueMarkdown`) and terminal web links (`WebLinksAddon`). Pure
 * and transport-agnostic so both the renderer (filtering before it even asks) and
 * main (`shell:openExternal`, the actual trust boundary) can share one check.
 */

/**
 * Validate and normalize a URL for opening outside the app: well-formed absolute
 * `http:`/`https:` only. Returns `parsed.href` (the normalized form — e.g. a bare
 * `http://example.com` becomes `http://example.com/`) rather than the original
 * string, so a caller that checks-then-opens acts on the exact value that was
 * validated instead of re-parsing (and potentially re-normalizing differently) a
 * second time.
 */
export function toSafeExternalUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '') {
    return undefined
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href
    }
    return undefined
  } catch {
    return undefined
  }
}

/** True only for well-formed absolute `http:`/`https:` URLs. */
export function isSafeExternalUrl(url: string): boolean {
  return toSafeExternalUrl(url) !== undefined
}
