/**
 * Control protocol between `octopus-cli` and the running app (newline-delimited JSON
 * over the Unix socket at `<dataDir>/control.sock`). Transport-agnostic and pure: it
 * lives in `shared` so the CLI (may import only `shared`) and the main-process server
 * use one contract. DTO shapes here are deliberately independent of `./dto`.
 */

export {
  OCTOPUS_CONTROL_SOCKET_ENV,
  controlSocketPath,
  resolveControlSocketPath
} from './data-paths'

/** Bump on any incompatible change to the envelope or per-method shapes. */
export const CONTROL_PROTOCOL_VERSION = 1

export const CONTROL_METHODS = [
  'projects.list',
  'task.create',
  'task.list',
  'session.open',
  'issues.list',
  'issues.get',
  'issues.add'
] as const
export type ControlMethod = (typeof CONTROL_METHODS)[number]

export const ControlErrorCode = {
  BadJson: 'bad_json',
  BadRequest: 'bad_request',
  UnknownMethod: 'unknown_method',
  VersionMismatch: 'version_mismatch',
  NotFound: 'not_found',
  NotReady: 'not_ready',
  /** The command ran but the app rejected/failed it (message carries the reason). */
  CommandFailed: 'command_failed',
  ShuttingDown: 'shutting_down',
  Internal: 'internal'
} as const
export type ControlErrorCode = (typeof ControlErrorCode)[keyof typeof ControlErrorCode]

// ── Shared value types ────────────────────────────────────────────────────────

export type ControlIssueStatus = 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done'
const ISSUE_STATUSES: readonly string[] = ['todo', 'in_progress', 'blocked', 'in_review', 'done']

export interface ControlProject {
  readonly name: string
  readonly path: string
  /** The project's configured default source branch, when set. */
  readonly defaultBranch?: string
}

export interface ControlTask {
  readonly id: string
  readonly name: string
  readonly project: string
  readonly branch: string
  readonly state: string
  /** Absent for a "No Repo" task. */
  readonly worktreePath?: string
  /** The issue bound to this task, if any. */
  readonly issueId?: string
}

export interface ControlIssueSummary {
  readonly id: string
  readonly name: string
  readonly status: ControlIssueStatus
  /** Project path; absent when the issue has no project. */
  readonly project?: string
  readonly taskId?: string
}

export interface ControlIssue extends ControlIssueSummary {
  /** Markdown. */
  readonly description: string
  /** Markdown; present only when non-empty (kept across status changes, shown while Blocked). */
  readonly blockedReasons?: string
}

// ── Per-method params / results ───────────────────────────────────────────────

export type ProjectsListParams = Record<string, never>
export interface ProjectsListResult {
  readonly projects: readonly ControlProject[]
}

export interface TaskCreateParams {
  /** Project name (as listed by `projects.list`). */
  readonly project: string
  readonly branch: string
  readonly sourceBranch?: string
  readonly name?: string
}
export interface TaskCreateResult {
  readonly taskId: string
}

export interface TaskListParams {
  /** Optional project name filter. */
  readonly project?: string
}
export interface TaskListResult {
  readonly tasks: readonly ControlTask[]
}

/**
 * Longest accepted `session.open` command, in UTF-8 bytes. The line is typed into a pty
 * that is still in canonical (cooked) mode when a slow shell has not yet started its line
 * editor, and the tty line discipline buffers at most 4096 bytes per line (N_TTY_BUF_SIZE);
 * longer input is silently truncated. 4000 leaves headroom for the trailing newline.
 */
export const MAX_COMMAND_BYTES = 4000

/**
 * Pure check of a `session.open` command; returns an error message, or undefined if fine.
 * Empty/blank is useless, and a newline/CR/NUL would make the interactive shell run the
 * text line by line (or truncate it), so the command must be a single line.
 */
export function checkLaunchCommand(command: string): string | undefined {
  if (command.trim().length === 0) return 'command must not be empty'
  if (/[\n\r\0]/.test(command)) return 'command must be a single line (no newline, CR or NUL)'
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    return `command too long (max ${MAX_COMMAND_BYTES} bytes)`
  }
  return undefined
}

/** Longest accepted `session.open` name (the tab title), in characters (code points). */
export const MAX_SESSION_NAME_CHARS = 30

/**
 * Pure check of a `session.open` name; returns an error message, or undefined if fine.
 * A tab title is one short line: no control characters, at most {@link MAX_SESSION_NAME_CHARS}.
 */
export function checkSessionName(name: string): string | undefined {
  if (name.trim().length === 0) return 'name must not be empty'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'name must not contain control characters'
  if ([...name].length > MAX_SESSION_NAME_CHARS) {
    return `name too long (max ${MAX_SESSION_NAME_CHARS} characters)`
  }
  return undefined
}

export interface SessionOpenParams {
  readonly taskId: string
  /** Tab title of the new session (see {@link checkSessionName}). Omitted = the default title. */
  readonly name?: string
  /**
   * Shell line typed once into the new session (its one-shot `launchCommand`). Omitted =
   * plain shell. See {@link checkLaunchCommand} for the limits.
   */
  readonly command?: string
}
export interface SessionOpenResult {
  readonly sessionId: string
}

export interface IssuesListParams {
  readonly status?: ControlIssueStatus
  /** Project name or absolute path. */
  readonly project?: string
}
export interface IssuesListResult {
  readonly issues: readonly ControlIssueSummary[]
}

export interface IssuesGetParams {
  readonly issueId: string
}
export interface IssuesGetResult {
  readonly issue: ControlIssue
}

export interface IssuesAddParams {
  readonly name: string
  readonly description: string
  /** Project identified by registered NAME or absolute PATH (server tries path first, then name). */
  readonly project?: string
  /** Defaults to `todo` server-side. */
  readonly status?: ControlIssueStatus
}
export interface IssuesAddResult {
  readonly issueId: string
}

export interface ControlMethodMap {
  'projects.list': { params: ProjectsListParams; result: ProjectsListResult }
  'task.create': { params: TaskCreateParams; result: TaskCreateResult }
  'task.list': { params: TaskListParams; result: TaskListResult }
  'session.open': { params: SessionOpenParams; result: SessionOpenResult }
  'issues.list': { params: IssuesListParams; result: IssuesListResult }
  'issues.get': { params: IssuesGetParams; result: IssuesGetResult }
  'issues.add': { params: IssuesAddParams; result: IssuesAddResult }
}

// ── Envelope ──────────────────────────────────────────────────────────────────

export interface ControlRequest<M extends ControlMethod = ControlMethod> {
  readonly id: string
  readonly version: number
  readonly method: M
  readonly params: ControlMethodMap[M]['params']
}

export interface ControlError {
  readonly code: ControlErrorCode
  readonly message: string
}

export type ControlReply<M extends ControlMethod = ControlMethod> =
  | { readonly id: string; readonly ok: true; readonly result: ControlMethodMap[M]['result'] }
  | { readonly id: string; readonly ok: false; readonly error: ControlError }

/** Build a failure reply. */
export function controlError(id: string, code: ControlErrorCode, message: string): ControlReply {
  return { id, ok: false, error: { code, message } }
}

/**
 * The seam between the control-socket transport (`adapters/control`, framing only)
 * and main's method dispatcher (`main/control-handlers`). Receives an already-parsed,
 * version-checked request; must always resolve (never reject) with a reply carrying
 * the same `id`.
 */
export type ControlHandler = (request: ControlRequest) => Promise<ControlReply>

// ── Parsing ───────────────────────────────────────────────────────────────────

export type ParseControlResult =
  | { readonly ok: true; readonly request: ControlRequest }
  | {
      readonly ok: false
      /** Request id when recoverable from the line, else `''`. */
      readonly id: string
      readonly error: ControlError
    }

/**
 * Parse and validate one request line. Pure. Validates the envelope and the shape of
 * `params` for the method (types of fields, required vs optional); semantic checks
 * (does the project exist, …) are the server's job.
 */
export function parseControlRequest(line: string): ParseControlResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return fail('', ControlErrorCode.BadJson, 'request is not valid JSON')
  }
  if (!isObject(raw)) {
    return fail('', ControlErrorCode.BadRequest, 'request must be a JSON object')
  }
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    return fail('', ControlErrorCode.BadRequest, '"id" must be a non-empty string')
  }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
    return fail(id, ControlErrorCode.BadRequest, '"version" must be an integer')
  }
  if (raw.version !== CONTROL_PROTOCOL_VERSION) {
    return fail(
      id,
      ControlErrorCode.VersionMismatch,
      `protocol version ${raw.version} not supported (server speaks ${CONTROL_PROTOCOL_VERSION})`
    )
  }
  if (typeof raw.method !== 'string') {
    return fail(id, ControlErrorCode.BadRequest, '"method" must be a string')
  }
  if (!(CONTROL_METHODS as readonly string[]).includes(raw.method)) {
    return fail(id, ControlErrorCode.UnknownMethod, `unknown method "${raw.method}"`)
  }
  const method = raw.method as ControlMethod
  const params = raw.params === undefined ? {} : raw.params
  if (!isObject(params)) {
    return fail(id, ControlErrorCode.BadRequest, '"params" must be an object')
  }
  const problem = validateParams(method, params)
  if (problem !== undefined) {
    return fail(id, ControlErrorCode.BadRequest, `${method}: ${problem}`)
  }
  return {
    ok: true,
    request: { id, version: raw.version, method, params } as ControlRequest
  }
}

function fail(id: string, code: ControlErrorCode, message: string): ParseControlResult {
  return { ok: false, id, error: { code, message } }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

type FieldKind = 'string' | 'status'
type Spec = Record<string, { kind: FieldKind; required: boolean }>

const req = (kind: FieldKind = 'string') => ({ kind, required: true })
const opt = (kind: FieldKind = 'string') => ({ kind, required: false })

const PARAM_SPECS: Record<ControlMethod, Spec> = {
  'projects.list': {},
  'task.create': {
    project: req(),
    branch: req(),
    sourceBranch: opt(),
    name: opt()
  },
  'task.list': { project: opt() },
  'session.open': { taskId: req(), command: opt(), name: opt() },
  'issues.list': { status: opt('status'), project: opt() },
  'issues.get': { issueId: req() },
  'issues.add': { name: req(), description: req(), project: opt(), status: opt('status') }
}

function validateParams(
  method: ControlMethod,
  params: Record<string, unknown>
): string | undefined {
  const spec = PARAM_SPECS[method]
  // Strict: an app older than the CLI must fail loudly on a param it does not know,
  // not silently drop it (e.g. a new optional flag).
  const unknown = Object.keys(params).find((k) => !Object.hasOwn(spec, k))
  if (unknown !== undefined) {
    return `unknown param "${unknown}" (is Octopus older than this octopus-cli?)`
  }
  for (const [key, { kind, required }] of Object.entries(spec)) {
    const v = params[key]
    if (v === undefined) {
      if (required) return `missing "${key}"`
      continue
    }
    if (typeof v !== 'string') return `"${key}" must be a string`
    if (
      v.length === 0 &&
      (required || key === 'sourceBranch' || key === 'name') &&
      key !== 'description' &&
      key !== 'command'
    ) {
      return `"${key}" must not be empty`
    }
    if (kind === 'status' && !ISSUE_STATUSES.includes(v)) {
      return `"${key}" must be one of ${ISSUE_STATUSES.join(', ')}`
    }
  }
  return undefined
}
