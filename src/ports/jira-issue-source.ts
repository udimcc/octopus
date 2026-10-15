/**
 * `JiraIssueSource` port (DESIGN "Jira import"). The single edge over the
 * LiteLLM MCP gateway's cached Jira data: read-only, and fetched only on
 * explicit user action (there is no polling or background sync) — the
 * gateway's own cache refreshes every few hours, so results reflect Jira as
 * of that cache, not the live ticket. Implemented by the LiteLLM Jira source
 * adapter (`src/adapters/jira/`, Wave 3); the application layer depends only
 * on this interface.
 */

import type { JiraIssue, JiraProject, JiraSprint, JiraSprintFilter } from '../domain/jira-import'

/** Filters for `search` — the Jira Import modal's project/assignee/days/sprint pickers. */
export interface JiraSearchFilters {
  readonly project?: string
  readonly assignee?: string
  readonly issueKey?: string
  readonly days?: number
  readonly sprint?: JiraSprintFilter
}

/**
 * One page of search results. `nextCursor` is an opaque string the caller
 * passes back to `search` to fetch the next page unchanged; its absence means
 * this is the last page. `total` is the gateway's reported total match count
 * for the filters, independent of how many pages have been fetched so far.
 */
export interface JiraSearchPage {
  readonly issues: readonly JiraIssue[]
  readonly nextCursor?: string
  readonly total: number
}

export interface JiraIssueSource {
  /** All Jira projects visible through the gateway, for the project picker. */
  listProjects(): Promise<readonly JiraProject[]>
  /** Sprints for a project, for the Sprint filter dropdown (DESIGN "Jira import"). */
  listSprints(project: string): Promise<readonly JiraSprint[]>
  /** One page of issues matching `filters`; pass the previous page's `nextCursor` to continue. */
  search(filters: JiraSearchFilters, cursor?: string): Promise<JiraSearchPage>
  /**
   * Fetch issues by key, e.g. to re-check an imported issue's current Jira
   * fields. Keys the gateway can't find (deleted, mistyped, no access) are
   * silently dropped — the result may be shorter than `keys`, never throw for
   * a missing key.
   */
  getIssues(keys: readonly string[]): Promise<readonly JiraIssue[]>
}

/**
 * - `noKey` — no Jira API key is configured (`CredentialsProvider.has` is false).
 * - `unauthorized` — the configured key was rejected by the gateway.
 * - `unreachable` — the gateway could not be reached (network/timeout).
 * - `gateway` — the gateway responded but with an unexpected/error shape.
 */
export type JiraSourceErrorKind = 'noKey' | 'unauthorized' | 'unreachable' | 'gateway'

/** Thrown by every `JiraIssueSource` method instead of returning an error value. */
export class JiraSourceError extends Error {
  constructor(
    readonly kind: JiraSourceErrorKind,
    message: string
  ) {
    super(message)
    this.name = new.target.name
  }
}
