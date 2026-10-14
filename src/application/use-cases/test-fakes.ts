/**
 * Shared fakes for the application use-case + command-loop tests. NOT a test file
 * itself (no `.test.ts` suffix, so vitest never executes it); it is imported by
 * the colocated `*.test.ts` files in this layer.
 *
 * It stays strictly inside the application boundary — it imports only `domain`,
 * `ports`, and `application` — so the boundary rule (`eslint-plugin-boundaries`)
 * is satisfied for a file classified as `application`. In particular it does NOT
 * import any adapter: every port is faked inline here (event bus, persistence,
 * settings, worktree provider, session manager, session-type registry), and the
 * only concrete helpers pulled in are pure application/domain code
 * (`MapRuntimeRegistry`, `createAjvConfigValidator`, `worstStatusWins`,
 * `Workspace`).
 */

import { Workspace } from '../../domain/workspace'
import { worstStatusWins } from '../../domain/task-state-aggregator'
import {
  asTaskId,
  asSessionId,
  asTypeId,
  asWindowId,
  asIssueId,
  type TaskId,
  type SessionId,
  type WindowId,
  type IssueId
} from '../../domain/ids'
import type { SessionConfig } from '../../domain/session-config'
import type {
  WorkspaceSnapshot,
  TaskSnapshot,
  SessionSnapshot,
  IssueSnapshot
} from '../../domain/snapshots'
import type { DomainEvent, EventBus, EventHandler, Unsubscribe } from '../../ports/event-bus'
import type { IdGenerator } from '../../ports/id-generator'
import type { Clock } from '../../ports/clock'
import type { Settings, SettingsStore, SettingsPatch } from '../../ports/settings-store'
import type { WorkspacePersistence, WindowRecord } from '../../ports/workspace-persistence'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  AdoptWorktreeRequest,
  AdoptWorktreeResult,
  RemoveWorktreeRequest,
  InspectRepoResult,
  RepoWorktree
} from '../../ports/worktree-provider'
import type {
  SessionManager,
  SessionRuntime,
  SessionRuntimeContext
} from '../../ports/session-runtime'
import {
  Capability,
  type SessionTypeProvider,
  type SessionTypeRegistry
} from '../../ports/session-type-provider'
import { MapRuntimeRegistry, type AppDependencies, type ScrollbackBuffers } from '../dependencies'
import type { StateLog, StateTransition } from '../../ports/state-log'
import type { CreateTaskInput, CreateTaskFromNewInput } from '../commands'
import { createAjvConfigValidator } from '../config-validator'

/**
 * Build a "From New Worktree" `CreateTaskInput` with sensible defaults for tests
 * that only need a task to exist (repoDir/branches irrelevant to the assertion).
 * Pass `name` and override any of the new-mode fields as needed.
 */
export function taskInput(
  name: string,
  overrides: Partial<Omit<CreateTaskFromNewInput, 'mode'>> = {}
): CreateTaskInput {
  return {
    mode: 'new',
    name,
    repoDir: '/repo',
    sourceBranch: 'main',
    newBranch: 'feature/x',
    ...overrides
  }
}

/** A fake runtime that records every call and exposes the context it was built with. */
export class FakeRuntime implements SessionRuntime {
  readonly ctx: SessionRuntimeContext
  started = false
  disposed = false
  stopped = false
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  /** When set, `start()` rejects with this error (drives StartFailed). */
  failStartWith?: Error
  /** Value returned by `currentCwd()` (undefined → cwd unavailable). */
  cwdValue?: string

  constructor(ctx: SessionRuntimeContext) {
    this.ctx = ctx
  }

  start(): Promise<void> {
    if (this.failStartWith) {
      return Promise.reject(this.failStartWith)
    }
    this.started = true
    return Promise.resolve()
  }
  write(data: string): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }
  stop(): Promise<void> {
    this.stopped = true
    return Promise.resolve()
  }
  dispose(): void {
    this.disposed = true
  }
  currentCwd(): Promise<string | undefined> {
    return Promise.resolve(this.cwdValue)
  }
}

/** Fake `SessionManager` that hands out {@link FakeRuntime}s and records them. */
export class FakeSessionManager implements SessionManager {
  readonly created: FakeRuntime[] = []
  /** Set to make the NEXT created runtime fail on start(). */
  failNextStartWith?: Error

  createRuntime(ctx: SessionRuntimeContext): SessionRuntime {
    const rt = new FakeRuntime(ctx)
    if (this.failNextStartWith) {
      rt.failStartWith = this.failNextStartWith
      this.failNextStartWith = undefined
    }
    this.created.push(rt)
    return rt
  }

  /** The most recently created runtime (the one a single use-case just started). */
  last(): FakeRuntime | undefined {
    return this.created[this.created.length - 1]
  }
}

/** Fake terminal `SessionTypeProvider`: delegates to the injected manager (§8). */
class FakeTerminalProvider implements SessionTypeProvider {
  readonly typeId = asTypeId('terminal')
  readonly displayName = 'Terminal'
  readonly icon = 'terminal'
  readonly availableFromVersion = 1
  readonly configSchema: object = {
    type: 'object',
    properties: {
      kind: { const: 'terminal' },
      shell: { type: 'string' },
      initialCommand: { type: 'string' },
      cwdOverride: { type: 'string' }
    },
    required: ['kind'],
    additionalProperties: false
  }
  readonly capabilities: ReadonlySet<Capability> = new Set()

  defaultConfig(worktreePath?: string): SessionConfig {
    return worktreePath ? { kind: 'terminal', cwdOverride: worktreePath } : { kind: 'terminal' }
  }
  createRuntime(manager: SessionManager, ctx: SessionRuntimeContext): SessionRuntime {
    return manager.createRuntime(ctx)
  }
}

/** Minimal registry holding a single provider, keyed by typeId. */
class FakeRegistry implements SessionTypeRegistry {
  private readonly map = new Map<string, SessionTypeProvider>()
  register(provider: SessionTypeProvider): void {
    this.map.set(provider.typeId, provider)
  }
  get(typeId: string): SessionTypeProvider | undefined {
    return this.map.get(typeId)
  }
  available(version: number): readonly SessionTypeProvider[] {
    return [...this.map.values()].filter((p) => p.availableFromVersion <= version)
  }
}

/** Fake persistence: records mutations; `transaction` runs its fn synchronously. */
export class FakePersistence implements WorkspacePersistence {
  readonly upsertedTasks: TaskSnapshot[] = []
  readonly deletedTasks: TaskId[] = []
  readonly upsertedSessions: SessionSnapshot[] = []
  readonly deletedSessions: SessionId[] = []
  readonly activeTaskSet: Array<TaskId | undefined> = []
  readonly upsertedIssues: IssueSnapshot[] = []
  readonly deletedIssues: IssueId[] = []
  /** Persisted issues keyed by id (I19, mirrors the `issues` table). Seeded from the initial snapshot. */
  readonly issues: Map<IssueId, IssueSnapshot>
  /** Persisted scrollback keyed by session id (mirrors the `session_scrollback` table). */
  readonly savedScrollback = new Map<SessionId, string>()
  /** Persisted last-known cwd keyed by session id (mirrors the `sessions.last_cwd` column). */
  readonly savedLastCwd = new Map<SessionId, string>()
  /** Persisted window records keyed by id (V1.5, mirrors the `windows` table). */
  readonly windows = new Map<WindowId, WindowRecord>()
  transactions = 0
  checkpointed = false
  private readonly initial: WorkspaceSnapshot

  constructor(initial: WorkspaceSnapshot = { tasks: [], activeTaskId: undefined }) {
    this.initial = initial
    this.issues = new Map((initial.issues ?? []).map((i) => [i.id, i]))
  }
  load(): WorkspaceSnapshot {
    return { ...this.initial, issues: [...this.issues.values()] }
  }
  upsertTask(task: TaskSnapshot): void {
    this.upsertedTasks.push(task)
  }
  deleteTask(taskId: TaskId): void {
    this.deletedTasks.push(taskId)
    // Mirror the real `issues.task_id ... ON DELETE SET NULL` (I19): any fake
    // issue bound to this task is unbound, not deleted.
    for (const issue of this.issues.values()) {
      if (issue.taskId === taskId) {
        this.issues.set(issue.id, { ...issue, taskId: undefined })
      }
    }
  }
  upsertIssue(issue: IssueSnapshot): void {
    this.upsertedIssues.push(issue)
    this.issues.set(issue.id, issue)
  }
  deleteIssue(id: IssueId): void {
    this.deletedIssues.push(id)
    this.issues.delete(id)
  }
  upsertSession(session: SessionSnapshot): void {
    this.upsertedSessions.push(session)
  }
  deleteSession(sessionId: SessionId): void {
    this.deletedSessions.push(sessionId)
    // Mirror the real ON DELETE CASCADE: dropping the session drops its scrollback.
    this.savedScrollback.delete(sessionId)
    this.savedLastCwd.delete(sessionId)
  }
  saveScrollback(sessionId: SessionId, data: string): void {
    this.savedScrollback.set(sessionId, data)
  }
  loadScrollback(sessionId: SessionId): string | undefined {
    return this.savedScrollback.get(sessionId)
  }
  saveLastCwd(sessionId: SessionId, cwd: string): void {
    this.savedLastCwd.set(sessionId, cwd)
  }
  loadLastCwd(sessionId: SessionId): string | undefined {
    return this.savedLastCwd.get(sessionId)
  }
  setActiveTask(taskId: TaskId | undefined): void {
    this.activeTaskSet.push(taskId)
  }
  loadWindows(): WindowRecord[] {
    return [...this.windows.values()]
  }
  upsertWindow(record: WindowRecord): void {
    this.windows.set(record.id, record)
  }
  deleteWindow(id: WindowId): void {
    this.windows.delete(id)
  }
  transaction<T>(fn: () => T): T {
    this.transactions++
    return fn()
  }
  checkpointAndClose(): void {
    this.checkpointed = true
  }
}

const DEFAULT_SETTINGS: Settings = {
  worktree: { location: '/octopus_repos' },
  terminal: {},
  defaultSessionTypeId: 'terminal',
  groupTasksByRepo: true
}

/** Fake settings store with a deep-merging `save`. */
export class FakeSettingsStore implements SettingsStore {
  private current: Settings
  /** Settable flag backing `loadFailed()` (mirrors `JsonSettingsStore`); default false. */
  simulateLoadFailed = false
  /** Every patch passed to `save`, in call order — lets a test assert "never saved". */
  readonly saveCalls: SettingsPatch[] = []
  constructor(initial: Settings = DEFAULT_SETTINGS) {
    this.current = initial
  }
  load(): Settings {
    return this.current
  }
  loadFailed(): boolean {
    return this.simulateLoadFailed
  }
  save(patch: SettingsPatch): Settings {
    this.saveCalls.push(patch)
    this.current = {
      ...this.current,
      worktree: { ...this.current.worktree, ...patch.worktree },
      terminal: { ...this.current.terminal, ...patch.terminal },
      defaultSessionTypeId: patch.defaultSessionTypeId ?? this.current.defaultSessionTypeId,
      // Mirrors the real `pickProjects(patch.projects, base.projects)`: an array
      // in the patch (even `[]`) replaces the current value; an absent/undefined
      // `patch.projects` falls back to whatever the current value is — including
      // `undefined`, i.e. "never seeded". `??` is correct here (not an `'in'`
      // check) because the real `pickProjects` only ever branches on
      // `Array.isArray(value)`, never on key presence.
      projects: patch.projects ?? this.current.projects,
      worktreeCreateTimeoutMs:
        patch.worktreeCreateTimeoutMs ?? this.current.worktreeCreateTimeoutMs,
      groupTasksByRepo: patch.groupTasksByRepo ?? this.current.groupTasksByRepo
    }
    return this.current
  }
}

/** Fake worktree provider whose `create`/`remove`/`isDirty` behaviour is configurable. */
export class FakeWorktreeProvider implements WorktreeProvider {
  readonly createCalls: CreateWorktreeRequest[] = []
  readonly adoptCalls: AdoptWorktreeRequest[] = []
  readonly removeCalls: RemoveWorktreeRequest[] = []
  readonly inspectCalls: string[] = []
  readonly listWorktreesCalls: string[] = []
  dirty = false
  /** When set, `create` rejects (script failure). */
  createRejectsWith?: Error
  /** When set, `adopt` rejects (not a git worktree / main-tree refusal). */
  adoptRejectsWith?: Error
  /** When set, `remove` rejects (safety refusal / spawn failure). */
  removeRejectsWith?: Error
  /** Path returned by a successful `create`. */
  createdPath = '/wt/task'
  /** Result returned by a successful `adopt` (main repo distinct from path). */
  adoptedPath = '/repo/../wt-existing'
  adoptedRepoRoot = '/repo'
  adoptedBranch: string | undefined = 'existing-branch'
  /**
   * Per-dir `inspectRepo` result, keyed by the exact `dir` passed in. An
   * unconfigured dir resolves to `{ root: dir }` (already the main checkout, no
   * default branch) — a sensible default so most tests need no setup.
   */
  readonly inspectResults = new Map<string, InspectRepoResult>()
  /** Dirs whose `inspectRepo` call rejects (not a git repository). */
  readonly inspectRejects = new Set<string>()
  /** Per-root `listWorktrees` result, keyed by `root`. Unconfigured roots resolve to `[]`. */
  readonly worktreeLists = new Map<string, RepoWorktree[]>()
  /** Roots whose `listWorktrees` call rejects (e.g. deleted/moved repo). */
  readonly listWorktreesRejects = new Set<string>()
  /** When set, every `inspectRepo` call awaits this before resolving/rejecting — see `pauseInspect`. */
  private inspectGate: Promise<void> | null = null

  /**
   * Blocks every subsequent `inspectRepo` call right before it would otherwise
   * resolve, until the returned function is called. Lets a test pin down ordering
   * across a `CommandLoop`'s single-writer FIFO (e.g. that a later-dispatched
   * command never starts executing until an earlier, still-in-flight one settles).
   */
  pauseInspect(): () => void {
    let release = (): void => {}
    this.inspectGate = new Promise((resolve) => {
      release = resolve
    })
    return () => {
      release()
      this.inspectGate = null
    }
  }

  async create(
    req: CreateWorktreeRequest,
    onProgress?: (line: string) => void
  ): Promise<CreateWorktreeResult> {
    this.createCalls.push(req)
    onProgress?.('provisioning...')
    if (this.createRejectsWith) {
      throw this.createRejectsWith
    }
    return {
      path: this.createdPath,
      script: 'git',
      args: ['worktree', 'add', '-b', req.newBranch, this.createdPath, req.sourceBranch]
    }
  }
  async adopt(req: AdoptWorktreeRequest): Promise<AdoptWorktreeResult> {
    this.adoptCalls.push(req)
    if (this.adoptRejectsWith) {
      throw this.adoptRejectsWith
    }
    return { path: this.adoptedPath, repoRoot: this.adoptedRepoRoot, branch: this.adoptedBranch }
  }
  async remove(req: RemoveWorktreeRequest): Promise<void> {
    this.removeCalls.push(req)
    if (this.removeRejectsWith) {
      throw this.removeRejectsWith
    }
  }
  async isDirty(): Promise<boolean> {
    return this.dirty
  }
  async inspectRepo(dir: string): Promise<InspectRepoResult> {
    this.inspectCalls.push(dir)
    if (this.inspectGate) {
      await this.inspectGate
    }
    if (this.inspectRejects.has(dir)) {
      throw new Error(`not a git repository: ${dir}`)
    }
    return this.inspectResults.get(dir) ?? { root: dir }
  }
  async listWorktrees(root: string): Promise<readonly RepoWorktree[]> {
    this.listWorktreesCalls.push(root)
    if (this.listWorktreesRejects.has(root)) {
      throw new Error(`not a git repository: ${root}`)
    }
    return this.worktreeLists.get(root) ?? []
  }
}

/**
 * Fake scrollback store: a plain per-session string accumulator (no byte cap —
 * the cap is the adapter's `RingBuffer` concern, tested there). Enough to assert
 * capture (`append`), the quit flush (`entries`), and the user-close free
 * (`delete`) in the use-case tests.
 */
export class FakeScrollbackStore implements ScrollbackBuffers {
  readonly buffers = new Map<SessionId, string>()
  append(id: SessionId, data: string): void {
    this.buffers.set(id, (this.buffers.get(id) ?? '') + data)
  }
  snapshot(id: SessionId): string | undefined {
    return this.buffers.get(id)
  }
  *entries(): Iterable<[SessionId, string]> {
    yield* this.buffers
  }
  delete(id: SessionId): void {
    this.buffers.delete(id)
  }
  clear(): void {
    this.buffers.clear()
  }
}

/** Recording {@link StateLog}: keeps every recorded transition for assertions (§11). */
export class RecordingStateLog implements StateLog {
  readonly records: StateTransition[] = []
  record(transition: StateTransition): void {
    this.records.push(transition)
  }
}

/** Recording event bus (synchronous fan-out), used to assert emitted events. */
export class RecordingBus implements EventBus {
  readonly events: DomainEvent[] = []
  private readonly handlers = new Set<EventHandler>()
  publish(event: DomainEvent): void {
    this.events.push(event)
    for (const h of [...this.handlers]) {
      h(event)
    }
  }
  subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  /** All recorded events of a given type. */
  ofType<T extends DomainEvent['type']>(type: T): Array<Extract<DomainEvent, { type: T }>> {
    return this.events.filter((e) => e.type === type) as Array<Extract<DomainEvent, { type: T }>>
  }
}

/** Deterministic id generator with monotonic, readable ids. */
export class SeqIdGenerator implements IdGenerator {
  private t = 0
  private s = 0
  private w = 0
  private i = 0
  newTaskId(): TaskId {
    this.t++
    return asTaskId(`task-${this.t}`)
  }
  newSessionId(): SessionId {
    this.s++
    return asSessionId(`session-${this.s}`)
  }
  newWindowId(): WindowId {
    this.w++
    return asWindowId(`window-${this.w}`)
  }
  newIssueId(): IssueId {
    this.i++
    return asIssueId(`issue-${this.i}`)
  }
}

/** A clock that returns a fixed, injectable time. */
export class FakeClock implements Clock {
  constructor(public t = 1_000) {}
  now(): number {
    return this.t
  }
}

export interface FakeDeps {
  readonly deps: AppDependencies
  readonly bus: RecordingBus
  readonly persistence: FakePersistence
  readonly settings: FakeSettingsStore
  readonly worktrees: FakeWorktreeProvider
  readonly sessions: FakeSessionManager
  readonly scrollbacks: FakeScrollbackStore
  readonly stateLog: RecordingStateLog
  readonly ids: SeqIdGenerator
  readonly clock: FakeClock
  readonly workspace: Workspace
}

/**
 * Assemble a full {@link AppDependencies} out of fakes. Pass an initial workspace
 * snapshot to hydrate restored state; otherwise the workspace starts empty.
 */
export function makeDeps(
  opts: { snapshot?: WorkspaceSnapshot; liveDaemonSessions?: ReadonlySet<SessionId> } = {}
): FakeDeps {
  const bus = new RecordingBus()
  const persistence = new FakePersistence(opts.snapshot)
  const settings = new FakeSettingsStore()
  const worktrees = new FakeWorktreeProvider()
  const sessions = new FakeSessionManager()
  const scrollbacks = new FakeScrollbackStore()
  const stateLog = new RecordingStateLog()
  const ids = new SeqIdGenerator()
  const clock = new FakeClock()
  const registry = new FakeRegistry()
  registry.register(new FakeTerminalProvider())

  const workspace = opts.snapshot
    ? Workspace.hydrate(opts.snapshot, { defaultSessionTypeId: 'terminal' })
    : Workspace.create({ defaultSessionTypeId: 'terminal' })

  const deps: AppDependencies = {
    workspace,
    persistence,
    settings,
    worktrees,
    sessions,
    registry,
    runtimes: new MapRuntimeRegistry(),
    bus,
    ids,
    clock,
    aggregator: worstStatusWins,
    configValidator: createAjvConfigValidator(),
    scrollbacks,
    stateLog,
    // Default session cwd for "No Repo" tasks (§5.4); a fixed, valid path in tests.
    homeDir: '/home/test',
    currentVersion: 1,
    liveDaemonSessions: opts.liveDaemonSessions
  }

  return {
    deps,
    bus,
    persistence,
    settings,
    worktrees,
    sessions,
    scrollbacks,
    stateLog,
    ids,
    clock,
    workspace
  }
}
