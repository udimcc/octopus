/**
 * `Issue` aggregate (DESIGN "Issues" / I19). A locally-tracked work item: a
 * required name, a markdown description, an optional configured project, and a
 * fixed status. An issue may be bound to at most one `Task`; the binding is
 * stored only here (`taskId`) — `Workspace` is the sole mutator of it, via
 * `bindTo`/`clearBinding`, so the 1:1 invariant and the todo→in_progress
 * automation stay centralized in `Workspace.bindIssue`/`unbindIssue` rather than
 * duplicated at every call site.
 */

import type { IssueId, TaskId } from './ids'
import type { IssueSnapshot } from './snapshots'
import { InvariantViolationError } from './errors'

/** Fixed status set ("Issues", §13.1). Users cannot add or remove statuses. */
export enum IssueStatus {
  Todo = 'todo',
  InProgress = 'in_progress',
  InReview = 'in_review',
  Done = 'done'
}

/**
 * Validate and cast an arbitrary value to {@link IssueStatus}. Shared by the
 * IPC edge (`ipc-handlers.ts`, rejecting a malformed wire payload before dispatch)
 * and persistence (`mappers.ts`'s `rowToIssueSnapshot`, defending a corrupt row) so
 * the one allowlist of valid strings lives in a single place. Returns `undefined`
 * for anything else — the caller decides what that means (reject vs. fall back).
 */
export function parseIssueStatus(value: unknown): IssueStatus | undefined {
  switch (value) {
    case IssueStatus.Todo:
      return IssueStatus.Todo
    case IssueStatus.InProgress:
      return IssueStatus.InProgress
    case IssueStatus.InReview:
      return IssueStatus.InReview
    case IssueStatus.Done:
      return IssueStatus.Done
    default:
      return undefined
  }
}

/**
 * Where an issue came from (Jira import feature). `Local` is the default for
 * every issue created or hydrated before this field existed. A `Jira` issue
 * always carries the `jiraKey` it was imported under; see `Issue`'s
 * constructor invariant.
 */
export enum IssueSource {
  Local = 'local',
  Jira = 'jira'
}

/**
 * Validate and cast an arbitrary value to {@link IssueSource}, modeled on
 * {@link parseIssueStatus}. Returns `undefined` for anything else — the
 * caller decides whether that means reject or fall back to `Local`.
 */
export function parseIssueSource(value: unknown): IssueSource | undefined {
  switch (value) {
    case IssueSource.Local:
      return IssueSource.Local
    case IssueSource.Jira:
      return IssueSource.Jira
    default:
      return undefined
  }
}

/** Trim and reject an empty result; shared by `Issue.create`/`rename` and by
 * `composeJiraIssue` (`jira-import.ts`), so the name invariant — and the exact
 * normalization a freshly-imported Jira issue's name goes through — is
 * enforced in exactly one place. (Not I19 — that invariant covers the
 * binding, not the name rule; this one has no assigned number.) */
export function normalizeIssueName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') {
    throw new InvariantViolationError('issue name must not be empty')
  }
  return trimmed
}

export interface IssueCreateProps {
  id: IssueId
  name: string
  description: string
  projectPath?: string
  createdAt: number
  /** Defaults to {@link IssueSource.Local} when omitted. */
  source?: IssueSource
  /** Required when `source` is {@link IssueSource.Jira}; forbidden otherwise. */
  jiraKey?: string
}

export class Issue {
  readonly id: IssueId
  readonly createdAt: number

  private _name: string
  private _description: string
  private _projectPath?: string
  private _status: IssueStatus
  private _taskId?: TaskId
  private _updatedAt: number
  private readonly _source: IssueSource
  private readonly _jiraKey?: string

  private constructor(props: IssueCreateProps) {
    const source = props.source ?? IssueSource.Local
    Issue.validateSourceAndKey(source, props.jiraKey)
    this.id = props.id
    this.createdAt = props.createdAt
    this._name = props.name
    this._description = props.description
    this._projectPath = props.projectPath
    this._status = IssueStatus.Todo
    this._updatedAt = props.createdAt
    this._source = source
    this._jiraKey = props.jiraKey
  }

  /** Enforce the source/key invariant: a `jiraKey` implies `source === Jira`,
   * and `source === Jira` requires a `jiraKey`. */
  private static validateSourceAndKey(source: IssueSource, jiraKey: string | undefined): void {
    if (jiraKey !== undefined && source !== IssueSource.Jira) {
      throw new InvariantViolationError('issue jiraKey requires source=jira')
    }
    if (source === IssueSource.Jira && jiraKey === undefined) {
      throw new InvariantViolationError('issue source=jira requires a jiraKey')
    }
  }

  /** Create a new, unbound issue in `Todo`. Validates `name` the same way `rename` does
   * (trim, reject empty) — the caller never needs its own workaround. */
  static create(props: IssueCreateProps): Issue {
    return new Issue({ ...props, name: normalizeIssueName(props.name) })
  }

  /** Reconstruct an issue from persistence (I15-style hydration). */
  static fromSnapshot(snap: IssueSnapshot): Issue {
    const issue = new Issue({
      id: snap.id,
      name: snap.name,
      description: snap.description,
      projectPath: snap.projectPath,
      createdAt: snap.createdAt,
      source: snap.source,
      jiraKey: snap.jiraKey
    })
    issue._status = snap.status
    issue._taskId = snap.taskId
    issue._updatedAt = snap.updatedAt
    return issue
  }

  get name(): string {
    return this._name
  }
  get description(): string {
    return this._description
  }
  get projectPath(): string | undefined {
    return this._projectPath
  }
  get status(): IssueStatus {
    return this._status
  }
  /** The task this issue is bound to, if any. Mutate only via `Workspace` (I19). */
  get taskId(): TaskId | undefined {
    return this._taskId
  }
  get updatedAt(): number {
    return this._updatedAt
  }
  /** Where this issue came from. Read-only — never settable after creation. */
  get source(): IssueSource {
    return this._source
  }
  /** The Jira key this issue was imported under, if any. Read-only. */
  get jiraKey(): string | undefined {
    return this._jiraKey
  }

  /** Rename; trims whitespace and rejects an empty result (see `normalizeIssueName`
   * — not I19, which covers the binding, not the name rule). */
  rename(name: string): void {
    this._name = normalizeIssueName(name)
  }

  setDescription(description: string): void {
    this._description = description
  }

  /** Set or clear (`undefined`) the configured project this issue tracks against. */
  setProject(path: string | undefined): void {
    this._projectPath = path
  }

  setStatus(status: IssueStatus): void {
    this._status = status
  }

  /** Stamp `updatedAt`; called explicitly by the application layer after a mutation. */
  touch(now: number): void {
    this._updatedAt = now
  }

  // ── Binding (I19) — called only by `Workspace.bindIssue`/`unbindIssue`/
  // `restoreIssueBinding`/`hydrate` ──
  // Mutating these directly bypasses the 1:1 invariant and the todo→in_progress
  // automation that `Workspace` enforces; every other caller must go through it
  // (application-layer rollbacks included — see `Workspace.restoreIssueBinding`,
  // used by `bind-issue.ts` and `create-task.ts` instead of calling these two
  // methods themselves).

  /** @internal set by `Workspace.bindIssue`/`restoreIssueBinding` only. */
  bindTo(taskId: TaskId): void {
    this._taskId = taskId
  }

  /** @internal cleared by `Workspace.unbindIssue`/`removeTask`/
   * `restoreIssueBinding`, and by `Workspace.hydrate` when the bound task no
   * longer exists on reload. */
  clearBinding(): void {
    this._taskId = undefined
  }

  toSnapshot(): IssueSnapshot {
    return {
      id: this.id,
      name: this._name,
      description: this._description,
      projectPath: this._projectPath,
      status: this._status,
      taskId: this._taskId,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      source: this._source,
      ...(this._jiraKey !== undefined ? { jiraKey: this._jiraKey } : {})
    }
  }
}
