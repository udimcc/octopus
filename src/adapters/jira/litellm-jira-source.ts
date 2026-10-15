/**
 * `JiraIssueSource` adapter over the LiteLLM MCP gateway (DESIGN "Jira import",
 * Wave 3). Octopus runs on the internal network; Jira lives on the external
 * one, so the only route is `POST {baseUrl}/mcp-rest/tools/call`, which
 * proxies to the upstream "JiraSSE" MCP server holding the real Jira
 * credentials. The gateway's own cache refreshes every few hours — this
 * adapter never talks to Jira directly, and there is no polling.
 *
 * The wire tool name carries the gateway's server alias prefix: calling the
 * upstream tool `jira_search` means `name: "jira_jira_search"` (confirmed
 * against the gateway; see `test/fixtures/jira/README.md`). `tool` below is
 * always the upstream name (already including its own `jira_` prefix), so
 * `call()` only prepends the alias.
 *
 * Everything the gateway returns is **text**, not structured JSON — three
 * line-oriented formats (`jira_search`, `jira_get_issue`, `jira_get_all_projects`)
 * are parsed by the pure, exported `parse*Text` functions below so adapter
 * tests can target them directly with the captured fixtures. The class itself
 * is a thin orchestrator: build request → call → parse → map to domain types.
 *
 * Every method throws `JiraSourceError` instead of returning an error value
 * (see the port). Messages are capped and never include the API key or the
 * `Authorization` header.
 */

import {
  JiraSourceError,
  type JiraIssueSource,
  type JiraSearchFilters,
  type JiraSearchPage,
  type JiraSourceErrorKind
} from '../../ports/jira-issue-source'
import {
  matchesSprintFilter,
  orderSprints,
  type JiraIssue,
  type JiraProject,
  type JiraSprint
} from '../../domain/jira-import'
import { adfToMarkdown } from './adf-to-markdown'
import { isPrintableAsciiKey } from '../../shared/jira-api-key'

/** Default LiteLLM gateway base URL (DESIGN "Jira import"). Overridable for tests/ops. */
export const DEFAULT_LITELLM_BASE_URL = 'https://litellm.israel.final'
/** The Jira MCP server's `server_id` on the gateway (alias "jira" / JiraSSE). */
export const DEFAULT_JIRA_SERVER_ID = '628a8d3ece8c06bc50523679ea834304'

const DEFAULT_TIMEOUT_MS = 30_000
const SEARCH_PAGE_LIMIT = 50
const GET_ISSUE_BATCH_SIZE = 10
/** Search pages scanned per `search()` call while hunting for sprint-filter matches. */
const MAX_SPRINT_FILTER_PAGES = 10
const MAX_MESSAGE_LENGTH = 300

/** The one `fetch` shape this adapter uses. `globalThis.fetch` satisfies it; the app
 * injects `createHttpsFetch()` (https-fetch.ts) so the internal CA is trusted. */
export type JiraFetch = (
  url: string,
  init: {
    readonly method: 'POST'
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
    readonly signal: AbortSignal
  }
) => Promise<Response>

export interface LiteLLMJiraSourceDeps {
  readonly fetch: JiraFetch
  /** Resolves the Jira API key, or `undefined`/empty when none is configured. */
  readonly getApiKey: () => Promise<string | undefined>
  readonly baseUrl: string
  readonly serverId: string
  /** Per-request abort timeout. Defaults to 30s. */
  readonly timeoutMs?: number
}

export class LiteLLMJiraSource implements JiraIssueSource {
  constructor(private readonly deps: LiteLLMJiraSourceDeps) {}

  async listProjects(): Promise<readonly JiraProject[]> {
    const text = await this.call('jira_get_all_projects', {})
    return parseProjectsText(text)
  }

  async listSprints(project: string): Promise<readonly JiraSprint[]> {
    // DESIGN "Jira import" asks for "the project's 30 most recent issues", not a
    // 30-day window (`days: 30` would silently return fewer than 30 issues'
    // worth of sprints for a quiet project). Confirmed against the fixtures
    // (`test/fixtures/jira/search-page1.json`/`search-page2.json`, project TM):
    // with no `days` argument the gateway's default order is already
    // newest-created-first — `Created` strictly decreases across both pages'
    // bullets with no sort parameter sent — so `searchPage({ project }, 0, 30)`
    // gives exactly the 30 most recent issues.
    const { keys } = await this.searchPage({ project }, 0, 30)
    const issues = await this.getIssues(keys)
    return orderSprints(issues.flatMap((issue) => issue.sprints))
  }

  async search(filters: JiraSearchFilters, cursor?: string): Promise<JiraSearchPage> {
    if (filters.issueKey !== undefined && filters.issueKey.trim() !== '') {
      const issues = await this.getIssues([filters.issueKey])
      return { issues, total: issues.length }
    }

    const sprintFilter = filters.sprint
    if (sprintFilter === undefined) {
      const offset = parseCursor(cursor)
      const { keys, total } = await this.searchPage(filters, offset, SEARCH_PAGE_LIMIT)
      const issues = await this.getIssues(keys)
      // M6: advance by the hits ACTUALLY returned, not the requested page size —
      // a short or empty page (the last page, or a filter the gateway only
      // partially honors) must not skip or repeat rows on the next call. An
      // empty page always ends paging, regardless of what `total` claims.
      const nextOffset = offset + keys.length
      return {
        issues,
        total,
        nextCursor: keys.length > 0 && nextOffset < total ? String(nextOffset) : undefined
      }
    }

    return this.searchWithSprintFilter(filters, sprintFilter, parseCursor(cursor))
  }

  private async searchWithSprintFilter(
    filters: JiraSearchFilters,
    sprintFilter: NonNullable<JiraSearchFilters['sprint']>,
    startOffset: number
  ): Promise<JiraSearchPage> {
    let offset = startOffset
    let total = 0
    let pagesScanned = 0
    let exhausted = false
    const matched: JiraIssue[] = []

    while (matched.length < SEARCH_PAGE_LIMIT && pagesScanned < MAX_SPRINT_FILTER_PAGES) {
      const page = await this.searchPage(filters, offset, SEARCH_PAGE_LIMIT)
      // Nit: keep the FIRST page's total. The gateway's reported total is for
      // the whole (unfiltered-by-sprint) query, not per-page, so it should be
      // stable across a multi-page scan — overwriting it every iteration broke
      // that invariant (and risked a result that looked inconsistent if a later
      // page's total ever differed from the first, e.g. a concurrent change).
      if (pagesScanned === 0) {
        total = page.total
      }
      pagesScanned += 1
      if (page.keys.length === 0) {
        exhausted = true
        break
      }
      const issues = await this.getIssues(page.keys)
      for (const issue of issues) {
        if (matchesSprintFilter(issue, sprintFilter)) {
          matched.push(issue)
        }
      }
      // M6: advance by the hits actually returned, same reasoning as `search`'s
      // non-sprint-filter path above.
      offset += page.keys.length
      if (offset >= total) {
        exhausted = true
        break
      }
    }

    return { issues: matched, total, nextCursor: exhausted ? undefined : String(offset) }
  }

  async getIssues(keys: readonly string[]): Promise<readonly JiraIssue[]> {
    const deduped = dedupe(keys)
    if (deduped.length === 0) return []
    const byKey = new Map<string, JiraIssue>()
    for (let i = 0; i < deduped.length; i += GET_ISSUE_BATCH_SIZE) {
      const batch = deduped.slice(i, i + GET_ISSUE_BATCH_SIZE)
      const text = await this.call('jira_get_issue', { ticket_id: batch.join(',') })
      for (const issue of parseIssueDetailsText(text)) {
        byKey.set(issue.key, issue)
      }
    }
    const result: JiraIssue[] = []
    for (const key of deduped) {
      const issue = byKey.get(key)
      if (issue !== undefined) result.push(issue)
    }
    return result
  }

  /** One `jira_search` call, parsed. `limit` differs between `search` (50) and
   * `listSprints` (30), everything else about the call shape is identical. */
  private async searchPage(
    filters: JiraSearchFilters,
    offset: number,
    limit: number
  ): Promise<{ keys: string[]; total: number }> {
    const args: Record<string, unknown> = { limit, offset }
    if (filters.project !== undefined) args.project = filters.project
    if (filters.assignee !== undefined) args.assignee = filters.assignee
    if (filters.days !== undefined) args.days = filters.days
    const text = await this.call('jira_search', args)
    return parseSearchText(text)
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<string> {
    let apiKey: string | undefined
    try {
      apiKey = await this.deps.getApiKey()
    } catch {
      // M1: a decrypt failure (a corrupted credentials file, or the OS keychain
      // unlocked under a different identity than when the key was stored) must
      // not surface as a generic gateway error — and must never include the
      // underlying message, which can carry a file path or a libsecret/DPAPI
      // error string.
      throw fail('noKey', 'the stored Jira API key could not be decrypted; re-enter it in Settings')
    }
    if (apiKey === undefined || apiKey.trim() === '') {
      throw fail('noKey', 'no Jira API key is configured')
    }
    const trimmedKey = apiKey.trim()
    if (!isPrintableAsciiKey(trimmedKey)) {
      // I1: a key with whitespace, control bytes or non-ASCII characters can't
      // be sent as an `Authorization` header value at all. Reject it clearly
      // here (the same rule `ipc-handlers.ts`'s `parseJiraKeyInput` applies at
      // save time, via the shared `isPrintableAsciiKey`) rather than letting it
      // fail inside `fetch` and masquerade as "gateway unreachable" — this also
      // covers a key written to the credentials file before this check existed.
      throw fail(
        'noKey',
        'the stored Jira API key contains invalid characters; re-enter it in Settings'
      )
    }
    const authorization = `Bearer ${trimmedKey}`
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

    let response: Response
    try {
      response = await this.deps.fetch(`${this.deps.baseUrl}/mcp-rest/tools/call`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `jira_${tool}`,
          arguments: args,
          server_id: this.deps.serverId
        }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (isTimeoutOrAbortError(error)) {
        throw fail('unreachable', 'Jira gateway timed out')
      }
      // I1: never include `error.message` — on a TLS/socket failure it can
      // embed the request URL, a certificate subject, or other low-level detail
      // that shouldn't reach the renderer. `error.name` plus the lower-level
      // `code` (set by Node's `https`/`undici` layer, surfaced either directly
      // or via `error.cause`) is enough to diagnose "unreachable" without that risk.
      throw fail('unreachable', `Jira gateway unreachable: ${describeError(error)}`)
    }

    if (response.status === 401 || response.status === 403) {
      throw fail('unauthorized', 'the Jira API key was rejected by the gateway')
    }
    if (!response.ok) {
      const body = await safeReadText(response)
      throw fail('gateway', `gateway returned ${response.status}: ${body}`)
    }

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch (error) {
      if (isTimeoutOrAbortError(error)) {
        throw fail('unreachable', 'Jira gateway timed out')
      }
      throw fail('gateway', 'gateway returned a malformed response body')
    }
    return extractEnvelopeText(envelope)
  }
}

function extractEnvelopeText(envelope: unknown): string {
  if (!isRecord(envelope)) {
    throw fail('gateway', 'malformed gateway envelope')
  }
  const content = Array.isArray(envelope.content) ? envelope.content : undefined
  if (content === undefined) {
    throw fail('gateway', 'malformed gateway envelope: missing content')
  }
  // M7: join with a newline, not '' — the reference client does the same, and
  // the gateway sends each `content[]` part as its own line-oriented chunk;
  // concatenating them with no separator can glue the last line of one part to
  // the first line of the next (observed as a `jira_search`/`jira_get_issue`
  // parse that merges two bullets or two issue blocks into one unparseable line).
  const text = content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
  if (envelope.isError === true) {
    throw fail('gateway', `gateway tool error: ${text}`)
  }
  return text
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    // M2: a body-read timeout/abort must not be swallowed into '' (which the
    // caller would then report as an empty, unhelpful "gateway returned 4xx/5xx:"
    // message) nor misreported as a malformed body — it is the same
    // unreachable-gateway condition as a connect-time timeout.
    if (isTimeoutOrAbortError(error)) {
      throw fail('unreachable', 'Jira gateway timed out')
    }
    return ''
  }
}

/** Construct a `JiraSourceError` with its message capped (I1) — every throw
 * site in this adapter goes through this, so no message can grow unbounded
 * (e.g. by embedding a large or garbled gateway response body) regardless of
 * which call site built it, and none can ever include a raw `error.message`. */
function fail(kind: JiraSourceErrorKind, message: string): JiraSourceError {
  return new JiraSourceError(kind, cap(message))
}

/** True for the error `fetch`/`Response#text|json` throw when `AbortSignal.timeout`
 * fires (Node/undici reject with a `TimeoutError`-named `DOMException`; a plain
 * caller-initiated abort is `AbortError`) — covers both naming conventions. */
function isTimeoutOrAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * A safe, non-leaking description of a thrown value for an "unreachable"
 * message (I1): the error's constructor name plus, when present, a lower-level
 * syscall/OpenSSL code (`ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`, …) read
 * from `error.code` or `error.cause.code` — NEVER `error.message`, which can
 * embed the request URL, a certificate subject/hostname, or other free text
 * that shouldn't reach the renderer.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const code = errorCode(error) ?? errorCode(causeOf(error))
  return code !== undefined ? `${error.name} (${code})` : error.name
}

function causeOf(error: Error): unknown {
  return (error as { cause?: unknown }).cause
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function cap(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}…` : trimmed
}

function dedupe(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key)
      result.push(key)
    }
  }
  return result
}

/**
 * Nit: a garbage cursor used to silently restart at offset 0 — a tampered or
 * stale client value would then quietly re-serve page 1 instead of surfacing
 * the problem. There is no dedicated port-level error kind for "invalid input"
 * (`JiraSourceErrorKind` is only `noKey|unauthorized|unreachable|gateway` —
 * `'invalid'` exists only at the DTO/IPC edge, `shared/dto.ts`'s `JiraErrorDTO`,
 * for input `main/ipc-handlers.ts` rejects before any port call), so `'gateway'`
 * is the closest existing bucket here. In the IPC path this is unreachable in
 * practice: `isValidCursor` in `ipc-handlers.ts` already rejects a malformed
 * cursor before it reaches the port, so this throw only guards a direct port
 * caller (a future non-IPC caller, or a test).
 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) {
    throw fail('gateway', 'invalid Jira search cursor')
  }
  const n = Number(cursor)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw fail('gateway', 'invalid Jira search cursor')
  }
  return n
}

// ---------------------------------------------------------------------------
// Parsers. Pure and exported so tests can target them with the fixtures
// directly, independent of the HTTP plumbing above.
// ---------------------------------------------------------------------------

const SEARCH_HEADER_RE = /^Found (\d+) total issues/m
const SEARCH_BULLET_RE = /^•\s*\[[^\]]*]\s*(\S+)\s*-/gm
const NO_ISSUES_PREFIX = 'No issues found'

/** Parses `jira_search` response text into the total match count and the hit keys
 * (bullet order). `"No issues found with filters: ..."` is an empty page, not an error. */
export function parseSearchText(text: string): { total: number; keys: string[] } {
  if (text.trim().startsWith(NO_ISSUES_PREFIX)) {
    return { total: 0, keys: [] }
  }
  const header = SEARCH_HEADER_RE.exec(text)
  if (header === null) {
    throw fail('gateway', `unexpected jira_search response: ${text}`)
  }
  const keys: string[] = []
  for (const match of text.matchAll(SEARCH_BULLET_RE)) {
    keys.push(match[1])
  }
  return { total: Number(header[1]), keys }
}

const PROJECT_LINE_RE = /^\s*•\s*([^\s:]+):\s*(\d+)\s*tickets?\s*$/gm
/** The `jira_get_all_projects` response's header line (`test/fixtures/jira/projects.json`:
 * `"Found 102 projects:"`). Its presence, even with zero `• KEY: N tickets` lines
 * following it, marks the text as a recognized (if legitimately empty) response —
 * distinct from text that matches NEITHER the header nor any bullet line, which is
 * an unrecognized format (M7). No "zero projects" response was ever captured, so
 * this fallback is unverified against a real fixture; it is the most direct
 * reading of the one captured header's own shape. */
const PROJECTS_HEADER_RE = /^Found \d+ projects:/m

/** Parses the `jira_get_all_projects` `  • KEY: N tickets` lines. */
export function parseProjectsText(text: string): JiraProject[] {
  const projects: JiraProject[] = []
  for (const match of text.matchAll(PROJECT_LINE_RE)) {
    projects.push({ key: match[1], ticketCount: Number(match[2]) })
  }
  if (projects.length === 0 && text.trim() !== '' && !PROJECTS_HEADER_RE.test(text)) {
    // M7: previously returned `[]` for ANY unparseable text, which could mask a
    // gateway response-format change as "this project list is just empty".
    throw fail('gateway', 'unrecognized project list format')
  }
  return projects
}

const ISSUE_HEADER_RE = /Issue (\S+) details:\s*\n/g

/**
 * Parses `jira_get_issue` response text: one or more `Issue KEY details:`
 * blocks, each followed by a raw Jira JSON object and a `---` separator (the
 * separator after the *last* block is not guaranteed, see the fixtures).
 * `"Issue X not found"` text for unknown keys has no `details:` header, so it
 * is naturally skipped. A block whose JSON fails to parse, or isn't a plain
 * object, is skipped — one bad issue never fails the whole batch.
 */
export function parseIssueDetailsText(text: string): JiraIssue[] {
  const issues: JiraIssue[] = []
  const re = new RegExp(ISSUE_HEADER_RE)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const key = match[1]
    const jsonStart = match.index + match[0].length
    const json = extractBalancedJson(text, jsonStart)
    if (json === undefined) continue
    re.lastIndex = jsonStart + json.length
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch {
      continue
    }
    const issue = mapIssue(key, raw)
    if (issue !== undefined) issues.push(issue)
  }
  return issues
}

/** A string-aware brace scan: returns the balanced `{...}` slice starting at
 * `start` (which must be `{`), respecting quoted strings and `\"` escapes so
 * braces inside string values never throw off the count. `undefined` when the
 * braces never balance before the text ends. */
function extractBalancedJson(text: string, start: number): string | undefined {
  if (text[start] !== '{') return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldName(value: unknown): string {
  return isRecord(value) && typeof value.name === 'string' ? value.name : ''
}

function fieldKey(value: unknown): string {
  return isRecord(value) && typeof value.key === 'string' ? value.key : ''
}

function displayName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.displayName === 'string' ? value.displayName : undefined
}

function mapSprints(value: unknown): JiraSprint[] {
  if (!Array.isArray(value)) return []
  const sprints: JiraSprint[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const { id, name, state } = item
    if (typeof id !== 'number' || typeof name !== 'string') continue
    if (state !== 'active' && state !== 'future' && state !== 'closed') continue
    sprints.push({ id, name, state })
  }
  return sprints
}

/** Belt-and-suspenders wrapper (I3) — see `mapIssue`. */
function safeAdfToMarkdown(doc: unknown): string {
  try {
    return adfToMarkdown(doc)
  } catch {
    return ''
  }
}

/** Maps one raw Jira issue JSON object (the gateway's full ~60-80 key field set) to
 * the small `JiraIssue` shape. Every field is tolerant of being missing or malformed
 * — this never throws; the caller skips the issue entirely only when `raw` itself
 * isn't a plain object. */
function mapIssue(key: string, raw: unknown): JiraIssue | undefined {
  if (!isRecord(raw)) return undefined
  return {
    key,
    summary: typeof raw.Summary === 'string' ? raw.Summary : '',
    // `adfToMarkdown` is documented pure/total (never throws, DESIGN §13.7), but
    // this call site adds a belt-and-suspenders `safeAdfToMarkdown` wrapper
    // anyway: one issue's malformed/unexpected ADF content must never fail the
    // whole batch parsed from one `jira_get_issue` response (I3).
    descriptionMarkdown: safeAdfToMarkdown(raw.Description),
    dodMarkdown: safeAdfToMarkdown(raw.dod),
    status: fieldName(raw.Status),
    priority: fieldName(raw.Priority),
    type: fieldName(raw['Issue Type']),
    assignee: displayName(raw.Assignee),
    reporter: displayName(raw.Reporter),
    created: typeof raw.Created === 'string' ? raw.Created : '',
    projectKey: fieldKey(raw.Project),
    sprints: mapSprints(raw.Sprint)
  }
}
