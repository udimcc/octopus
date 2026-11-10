import type { IssuesGetResult } from '../shared/control-protocol'

/**
 * Pure: an `issues get` result as readable markdown (`issues get --markdown`), for a human
 * or a Claude prompt. Real newlines, no JSON escaping; empty sections are omitted.
 */
export function issueToMarkdown({ issue }: IssuesGetResult): string {
  const meta = [`- Id: ${issue.id}`, `- Status: ${issue.status}`]
  if (issue.project) meta.push(`- Project: ${issue.project}`)
  const parts = [`# ${issue.name}`, meta.join('\n')]
  if (issue.blockedReasons?.trim())
    parts.push(`## Blocked reasons\n\n${issue.blockedReasons.trim()}`)
  parts.push(`## Description\n\n${issue.description.trim() || '(no description)'}`)
  return parts.join('\n\n') + '\n'
}
