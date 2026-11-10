/**
 * DTO to command validators shared by both inbound transports of `main`: the
 * renderer IPC handlers (`ipc-handlers.ts`) and the octopus-cli control dispatcher
 * (`control-handlers.ts`). Pure; each returns an error string for malformed input
 * (rejected before reaching the command loop) rather than throwing.
 */

import type { CreateIssueInput } from '../application/commands'
import type { SplitDirection, SplitPath } from '../shared/dto'
import { parseIssueStatus, type IssueStatus } from '../domain/issue'

/**
 * Validate a wire issue-status string against the domain enum (§13.4), shared with
 * `mappers.ts`'s defense of a corrupt DB row (`domain/issue.ts`). Returns the parsed
 * status, or `{ error }` if `status` was present but didn't match one of
 * `IssueStatusDTO`'s values — a malformed/stale-client payload, rejected here rather
 * than silently treated as absent (the command's own default, `todo`).
 */
export function parseIssueStatusInput(status: unknown): {
  readonly status?: IssueStatus
  readonly error?: string
} {
  if (status === undefined) {
    return {}
  }
  const parsed = parseIssueStatus(status)
  if (parsed === undefined) {
    return { error: `Invalid issue status: ${String(status)}` }
  }
  return { status: parsed }
}

/**
 * Validate a `createIssue` payload (name/description strings, optional status) and
 * build the application command input. `projectPath` is forwarded as given.
 */
export function parseCreateIssueInput(input: {
  readonly name: unknown
  readonly description: unknown
  readonly projectPath?: string
  readonly status?: unknown
}):
  | { readonly input: CreateIssueInput; readonly error?: undefined }
  | { readonly error: string; readonly input?: undefined } {
  if (typeof input.name !== 'string' || typeof input.description !== 'string') {
    return { error: 'Invalid issue name or description' }
  }
  const status = parseIssueStatusInput(input.status)
  if (status.error) {
    return { error: status.error }
  }
  return {
    input: {
      name: input.name,
      description: input.description,
      projectPath: input.projectPath,
      status: status.status
    }
  }
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function isSplitDirection(v: unknown): v is SplitDirection {
  return v === 'row' || v === 'col'
}

/** A {@link SplitPath}: an array of only `'a'`/`'b'` steps (possibly empty). */
export function isSplitPath(v: unknown): v is SplitPath {
  return Array.isArray(v) && v.every((step) => step === 'a' || step === 'b')
}
