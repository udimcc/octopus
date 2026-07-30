/**
 * `AppDependencies` — the port bag the application use-cases operate on
 * (DESIGN §2). The composition root builds concrete adapters and assembles this;
 * the use-cases receive it and touch nothing but ports + the domain `Workspace`.
 * This is what keeps the application free of any adapter import (boundary rule).
 *
 * The `Workspace` aggregate lives here as mutable in-memory state; every mutation
 * flows through the single-writer command loop (§6.6), so no locking is needed.
 */

import type { Workspace } from '../domain/workspace'
import type { TaskStateAggregator } from '../domain/task-state-aggregator'
import type { WorkspacePersistence } from '../ports/workspace-persistence'
import type { SettingsStore } from '../ports/settings-store'
import type { WorktreeProvider } from '../ports/worktree-provider'
import type { SessionManager } from '../ports/session-runtime'
import type { SessionTypeRegistry } from '../ports/session-type-provider'
import type { EventBus } from '../ports/event-bus'
import type { IdGenerator } from '../ports/id-generator'
import type { Clock } from '../ports/clock'
import type { SessionId } from '../domain/ids'
import type { SessionRuntime, StateChangeMeta } from '../ports/session-runtime'
import type { SessionState } from '../domain/state'
import type { StateLog } from '../ports/state-log'
import type { ConfigValidator } from './config-validator'

/** Provisions the (dormant in V1) per-session state socket path (§9.2, §10). */
export interface SocketProvisioner {
  socketPathFor(sessionId: SessionId): string
  ensureSocketDir(): void
}

/**
 * In-memory, byte-capped accumulator of each session's terminal OUTPUT, keyed by
 * session id. This realizes the §6.6 backend ring buffer (deferred in V1's
 * renderer-only replay) so scrollback can be persisted and replayed on restart
 * (§6.2 durable-backend seam). Held outside the domain — captured output is
 * metadata, not live process state, so it does NOT violate I13: on restart a
 * FRESH PTY is still spawned and the history is only prepended for the user to
 * read. Mirrors the `RuntimeRegistry` interface-in-application / impl-in-adapter
 * split so the application never imports the concrete ring buffer.
 */
export interface ScrollbackBuffers {
  /** Append a chunk of a session's output (byte-capped, oldest evicted). */
  append(id: SessionId, data: string): void
  /** The retained output for a session (oldest → newest), or undefined if none. */
  snapshot(id: SessionId): string | undefined
  /** All buffered sessions as `[id, output]` pairs (for the quit flush). */
  entries(): Iterable<[SessionId, string]>
  /** Drop a session's buffer (on user close — the session is gone). */
  delete(id: SessionId): void
  /** Drop every buffer (teardown). */
  clear(): void
}

/**
 * The live registry of running session runtimes, keyed by session id. Held
 * outside the domain (a `SessionRuntime` is an adapter handle, not domain state —
 * I13: live process state is never persisted). Use-cases start/stop runtimes and
 * record them here; the command loop routes `writeToPty`/`resizePty` through it.
 */
export interface RuntimeRegistry {
  get(sessionId: SessionId): SessionRuntime | undefined
  set(sessionId: SessionId, runtime: SessionRuntime): void
  delete(sessionId: SessionId): void
  all(): readonly SessionRuntime[]
  clear(): void
}

export interface AppDependencies {
  /** In-memory workspace aggregate; mutated only via the command loop (§6.6). */
  readonly workspace: Workspace
  readonly persistence: WorkspacePersistence
  readonly settings: SettingsStore
  readonly worktrees: WorktreeProvider
  readonly sessions: SessionManager
  readonly registry: SessionTypeRegistry
  /** Live runtime handles (not persisted, I13). */
  readonly runtimes: RuntimeRegistry
  readonly bus: EventBus
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly aggregator: TaskStateAggregator
  readonly configValidator: ConfigValidator
  /**
   * Best-effort state-transition log (§11, R1). Each `ingestSessionState` records
   * the transition here for threshold tuning and the debug overlay; a no-op
   * implementation (or absence) disables logging. Never throws into the loop.
   */
  readonly stateLog?: StateLog
  /** Dormant state-socket provisioner (§9.2, §10 V1 seam). */
  readonly socketProvisioner: SocketProvisioner
  /** Per-session output accumulator for scrollback persistence (§6.6, §6.2). */
  readonly scrollbacks: ScrollbackBuffers
  /** The app feature version (§10); gates session-type availability. */
  readonly currentVersion: number
  /**
   * Session ids the durable backend (§6.2) still holds a LIVE PTY for, captured
   * from the daemon's roster at bootstrap. `startSessionRuntime` consults this to
   * decide RE-ATTACH (`ctx.resume`) vs fresh spawn, and `startTaskSessions` gates
   * history-replay on it (a re-attach replays the daemon's own richer live buffer).
   * Undefined/empty on the in-process backend — which preserves V1 behavior
   * exactly: every restored session spawns fresh (§10 additive seam).
   */
  readonly liveDaemonSessions?: ReadonlySet<SessionId>
  /**
   * Late-bound sink for a runtime's SPONTANEOUS exit (§6.1). Set by the
   * composition root AFTER the command loop exists, to
   * `(sessionId, …) => loop.dispatch({ kind: 'handleRuntimeExit', … })` — so the
   * `markExited` mutation runs on the single writer, never inline in the PTY
   * callback (§6.6). Mutable by design (chicken-and-egg with the loop).
   */
  onRuntimeExit?: (sessionId: SessionId, exitCode?: number, signal?: number) => void
  /**
   * Late-bound sink for a runtime's evaluated STATE change (§9.6). Bound by the
   * composition root — like {@link onRuntimeExit} — to
   * `(sessionId, state) => loop.dispatch({ kind: 'ingestSessionState', … })`, so
   * the `setState` + task re-derivation run on the single writer, never inline in
   * the evaluator's push callback (§6.6). `startSessionRuntime` subscribes each
   * runtime's `stateEvaluator()` to it; a runtime whose type lacks `EvaluatesState`
   * returns null and is simply not subscribed. Absent ⇒ state ingestion is off
   * (preserves the pre-phase-2 no-icons behavior exactly).
   */
  onSessionState?: (sessionId: SessionId, state: SessionState, meta?: StateChangeMeta) => void
}

/** Simple `Map`-backed runtime registry (composition-root default). */
export class MapRuntimeRegistry implements RuntimeRegistry {
  private readonly map = new Map<SessionId, SessionRuntime>()

  get(sessionId: SessionId): SessionRuntime | undefined {
    return this.map.get(sessionId)
  }
  set(sessionId: SessionId, runtime: SessionRuntime): void {
    this.map.set(sessionId, runtime)
  }
  delete(sessionId: SessionId): void {
    this.map.delete(sessionId)
  }
  all(): readonly SessionRuntime[] {
    return [...this.map.values()]
  }
  clear(): void {
    this.map.clear()
  }
}
