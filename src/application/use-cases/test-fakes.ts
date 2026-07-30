/**
 * Shared fakes for the application use-case + command-loop tests. NOT a test file
 * itself (no `.test.ts` suffix, so vitest never executes it); it is imported by
 * the colocated `*.test.ts` files in this layer.
 *
 * It stays strictly inside the application boundary — it imports only `domain`,
 * `ports`, and `application` — so the boundary rule (`eslint-plugin-boundaries`)
 * is satisfied for a file classified as `application`. In particular it does NOT
 * import any adapter: every port is faked inline here (event bus, persistence,
 * settings, worktree provider, session manager, session-type registry, socket
 * provisioner), and the only concrete helpers pulled in are pure application/domain
 * code (`MapRuntimeRegistry`, `createAjvConfigValidator`, `worstStatusWins`,
 * `Workspace`).
 */

import { Workspace } from '../../domain/workspace'
import { worstStatusWins } from '../../domain/task-state-aggregator'
import {
  asTaskId,
  asSessionId,
  asTypeId,
  asWindowId,
  type TaskId,
  type SessionId,
  type WindowId
} from '../../domain/ids'
import type { SessionConfig } from '../../domain/session-config'
import type { WorkspaceSnapshot, TaskSnapshot, SessionSnapshot } from '../../domain/snapshots'
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
  RemoveWorktreeRequest
} from '../../ports/worktree-provider'
import type {
  SessionManager,
  SessionRuntime,
  SessionRuntimeContext,
  StateEvaluator
} from '../../ports/session-runtime'
import {
  Capability,
  type SessionTypeProvider,
  type SessionTypeRegistry
} from '../../ports/session-type-provider'
import {
  MapRuntimeRegistry,
  type AppDependencies,
  type SocketProvisioner,
  type ScrollbackBuffers
} from '../dependencies'
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
  /** Returned by `stateEvaluator()`; null → no evaluator (the default). */
  evaluator: StateEvaluator | null = null

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
  stateEvaluator(): StateEvaluator | null {
    return this.evaluator
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

  defaultConfig(worktreePath: string): SessionConfig {
    return { kind: 'terminal', cwdOverride: worktreePath }
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
  }
  load(): WorkspaceSnapshot {
    return this.initial
  }
  upsertTask(task: TaskSnapshot): void {
    this.upsertedTasks.push(task)
  }
  deleteTask(taskId: TaskId): void {
    this.deletedTasks.push(taskId)
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
  constructor(initial: Settings = DEFAULT_SETTINGS) {
    this.current = initial
  }
  load(): Settings {
    return this.current
  }
  save(patch: SettingsPatch): Settings {
    this.current = {
      ...this.current,
      worktree: { ...this.current.worktree, ...patch.worktree },
      terminal: { ...this.current.terminal, ...patch.terminal },
      defaultSessionTypeId: patch.defaultSessionTypeId ?? this.current.defaultSessionTypeId,
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
}

/** Fake socket provisioner (§9.2 dormant seam): pure path, records ensureSocketDir. */
export class FakeSocketProvisioner implements SocketProvisioner {
  ensured = 0
  socketPathFor(sessionId: SessionId): string {
    return `/tmp/octopus-test/session-${sessionId}.sock`
  }
  ensureSocketDir(): void {
    this.ensured++
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
  readonly socketProvisioner: FakeSocketProvisioner
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
  const socketProvisioner = new FakeSocketProvisioner()
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
    socketProvisioner,
    scrollbacks,
    stateLog,
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
    socketProvisioner,
    scrollbacks,
    stateLog,
    ids,
    clock,
    workspace
  }
}
