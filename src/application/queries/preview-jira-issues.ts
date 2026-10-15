/**
 * `previewJiraIssues` read query (DESIGN "Jira import"). Composes and
 * classifies each fetched `JiraIssue` against the workspace's CURRENT issues
 * so the Jira Import modal can label every row New/Duplicate/Conflict before
 * the user picks what to import.
 *
 * Pure read, like `listProjects`/`getSessionCwd`: it mutates nothing, so it
 * bypasses the single-writer command loop entirely. `importJiraIssues` (the
 * use case) re-classifies independently at dispatch time against whatever the
 * workspace looks like THEN — the two can disagree if the workspace changed
 * between preview and import (e.g. another import landed first), which is why
 * the use case never trusts this preview's classification.
 */

import type { AppDependencies } from '../dependencies'
import type { JiraIssue, JiraClassification } from '../../domain/jira-import'
import { composeJiraIssue, classifyJiraIssue } from '../../domain/jira-import'

/** One previewed row: the raw fetched issue, its composed Octopus fields, and
 * how it classifies against the workspace right now. */
export interface JiraIssuePreview {
  readonly issue: JiraIssue
  readonly composed: { readonly name: string; readonly description: string }
  readonly classification: JiraClassification
}

export function previewJiraIssues(
  deps: AppDependencies,
  issues: readonly JiraIssue[]
): readonly JiraIssuePreview[] {
  const existingIssues = deps.workspace.issues()
  return issues.map((issue) => {
    const composed = composeJiraIssue(issue)
    const classification = classifyJiraIssue(composed, issue.key, existingIssues)
    return { issue, composed, classification }
  })
}
