/**
 * Jira issue key validation and normalization ("Jira import", DESIGN §13.7). Pure and
 * transport-agnostic, like `external-url.ts`, so both the renderer (the Issue-key
 * filter field) and main (`main/ipc-handlers.ts`'s validators) share one check instead
 * of two copies drifting apart.
 *
 * The shape is `PROJECT-123`: an uppercase project key (a letter, then letters/digits/
 * underscores) followed by `-` and a positive integer with no leading zero. A comma
 * list, or whitespace inside the key, is invalid — the caller splits/trims a list
 * itself before normalizing each entry.
 */

const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/

/**
 * Trim and uppercase `raw`, returning it only if the result matches the Jira issue
 * key shape; otherwise `undefined`. Does not accept comma lists or internal whitespace.
 */
export function normalizeJiraIssueKey(raw: string): string | undefined {
  const normalized = raw.trim().toUpperCase()
  return JIRA_ISSUE_KEY_PATTERN.test(normalized) ? normalized : undefined
}

/** True only for a well-formed Jira issue key (after the same trim/uppercase normalization). */
export function isJiraIssueKey(value: string): boolean {
  return normalizeJiraIssueKey(value) !== undefined
}
