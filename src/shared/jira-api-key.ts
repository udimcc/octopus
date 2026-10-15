/**
 * Jira API key character validation (DESIGN §13.7, I1). The LiteLLM gateway call
 * sends the key verbatim in an `Authorization: Bearer <key>` HTTP header, which
 * can't carry whitespace, control bytes or non-ASCII text. A key with any of
 * those (a pasted newline, a copy-paste artifact) would otherwise fail at fetch
 * time and surface as a confusing "gateway unreachable" error instead of a clear
 * "invalid key" one. Shared so `main/ipc-handlers.ts` (reject at save time) and
 * `LiteLLMJiraSource` (reject at use time, for a key stored before this check
 * existed, or written directly into the credentials file) apply the identical rule.
 */

/** Printable ASCII, excluding space and control bytes (0x21–0x7e) — the full
 * visible range a header value can safely carry. */
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/

/** True iff `key` is one or more printable, non-whitespace ASCII characters. */
export function isPrintableAsciiKey(key: string): boolean {
  return PRINTABLE_ASCII_PATTERN.test(key)
}
