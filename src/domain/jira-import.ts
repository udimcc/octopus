/**
 * Pure Jira import rules (DESIGN "Jira import"). Everything here is a plain
 * value type or a pure function: composing an Octopus issue's name/description
 * from a fetched Jira issue, classifying it against the current workspace as
 * New/Duplicate/Conflict, and ordering/filtering sprints. No I/O, no gateway
 * shape — the adapter (`src/adapters/jira/litellm-jira-source.ts`, Wave 3)
 * maps the gateway's wire format into `JiraIssue` before any of this runs.
 */

import type { IssueId } from './ids'
import type { Issue } from './issue'
import { normalizeIssueName } from './issue'

/** A sprint as reported by Jira, already resolved to a stable shape. */
export interface JiraSprint {
  readonly id: number
  readonly name: string
  readonly state: 'active' | 'future' | 'closed'
}

/** A single Jira issue, already extracted from the gateway's text/JSON wire format. */
export interface JiraIssue {
  readonly key: string
  readonly summary: string
  /** Jira's ADF description, already converted to markdown (`adfToMarkdown`). */
  readonly descriptionMarkdown: string
  /** The "Definition of Done" custom field, already converted to markdown. Empty when unset. */
  readonly dodMarkdown: string
  readonly status: string
  readonly priority: string
  readonly type: string
  readonly assignee?: string
  readonly reporter?: string
  readonly created: string
  readonly projectKey: string
  readonly sprints: readonly JiraSprint[]
}

/** A Jira project, as listed by `jira_get_all_projects`. */
export interface JiraProject {
  readonly key: string
  readonly ticketCount: number
}

/**
 * The result of matching a fetched Jira issue against the current workspace
 * by `jiraKey` (see `classifyJiraIssue`). `duplicate`/`conflict` name the
 * existing Octopus issue so the UI can label the row.
 */
export type JiraClassification =
  | { readonly kind: 'new' }
  | {
      readonly kind: 'duplicate' | 'conflict'
      readonly issueId: IssueId
      readonly issueName: string
    }

/** The Sprint filter in the Jira Import modal: pick a known sprint by id, or
 * fall back to a free-text name match when a project has no sprints. */
export type JiraSprintFilter =
  | { readonly kind: 'id'; readonly id: number; readonly name: string }
  | { readonly kind: 'name'; readonly text: string }

/**
 * Compose the Octopus `name`/`description` an imported issue would get from a
 * fetched `JiraIssue`. Deterministic and idempotent: composing the same
 * `JiraIssue` twice (e.g. on a re-fetch) always yields byte-identical output,
 * so a freshly-imported issue re-classifies as `duplicate`, never `conflict`
 * (`classifyJiraIssue` compares this output against the stored issue byte for
 * byte).
 *
 * - `name` is `"KEY: Summary"`, run through `normalizeIssueName` — the exact
 *   trim/empty-check `Issue.create`/`rename` use — so a composed name can
 *   never silently differ from what `Issue.create` would store.
 * - `description` is the description markdown, trimmed; when the DOD markdown
 *   is non-empty after trimming, a `"## Definition of Done"` section is
 *   appended. When the description is empty, the DOD section is the entire
 *   description (no leading blank lines). `Issue.setDescription`/`create`
 *   store the description as given with no further normalization, so trimming
 *   here is what keeps re-composed output stable.
 */
export function composeJiraIssue(issue: JiraIssue): { name: string; description: string } {
  return {
    name: normalizeIssueName(`${issue.key}: ${issue.summary}`),
    description: composeDescription(issue.descriptionMarkdown, issue.dodMarkdown)
  }
}

function composeDescription(descriptionMarkdown: string, dodMarkdown: string): string {
  const description = descriptionMarkdown.trim()
  const dod = dodMarkdown.trim()
  if (dod === '') {
    return description
  }
  const dodSection = `## Definition of Done\n${dod}`
  return description === '' ? dodSection : `${description}\n\n${dodSection}`
}

/**
 * Classify a composed Jira issue against the issues already in the workspace
 * (DESIGN "Duplicates and conflicts"). Matches first on `jiraKey`:
 * - No existing issue has this key → `new`.
 * - An existing issue has this key, and its stored name/description are
 *   exactly equal to `composed` → `duplicate`.
 * - An existing issue has this key, but either differs → `conflict` (e.g. a
 *   local edit after import).
 *
 * Deleting the matching Octopus issue removes it from `existingIssues`, so
 * the same Jira issue classifies as `new` again on the next fetch.
 */
export function classifyJiraIssue(
  composed: { readonly name: string; readonly description: string },
  jiraKey: string,
  existingIssues: readonly Issue[]
): JiraClassification {
  const existing = existingIssues.find((issue) => issue.jiraKey === jiraKey)
  if (existing === undefined) {
    return { kind: 'new' }
  }
  const unchanged = existing.name === composed.name && existing.description === composed.description
  return {
    kind: unchanged ? 'duplicate' : 'conflict',
    issueId: existing.id,
    issueName: existing.name
  }
}

const SPRINT_STATE_ORDER: Record<JiraSprint['state'], number> = {
  active: 0,
  future: 1,
  closed: 2
}

/**
 * Dedupe sprints by id, then sort active → future → closed (the Sprint
 * dropdown's order). Within the same state, sorts by id descending: Jira
 * assigns sprint ids sequentially, so the highest id is the most recently
 * created sprint in that state — this surfaces the newest sprint first within
 * each bucket. When the same id appears more than once, the later occurrence
 * in `sprints` wins (last writer, matching how the adapter accumulates
 * sprints while scanning issues).
 */
export function orderSprints(sprints: readonly JiraSprint[]): JiraSprint[] {
  const byId = new Map<number, JiraSprint>()
  for (const sprint of sprints) {
    byId.set(sprint.id, sprint)
  }
  return [...byId.values()].sort((a, b) => {
    const stateDiff = SPRINT_STATE_ORDER[a.state] - SPRINT_STATE_ORDER[b.state]
    return stateDiff !== 0 ? stateDiff : b.id - a.id
  })
}

/**
 * Does `issue` belong to the sprint named by `filter`? `kind:'id'` matches an
 * exact sprint id (the dropdown case). `kind:'name'` does a case-insensitive
 * substring match against the issue's sprint names (the free-text fallback
 * for projects with no sprints); a filter text that is empty after trimming
 * matches every issue.
 */
export function matchesSprintFilter(issue: JiraIssue, filter: JiraSprintFilter): boolean {
  if (filter.kind === 'id') {
    return issue.sprints.some((sprint) => sprint.id === filter.id)
  }
  const text = filter.text.trim().toLowerCase()
  if (text === '') {
    return true
  }
  return issue.sprints.some((sprint) => sprint.name.toLowerCase().includes(text))
}
