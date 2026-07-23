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
import type { SessionRuntime } from '../ports/session-runtime'
import type { ConfigValidator } from './config-validator'

/** Provisions the (dormant in V1) per-session state socket path (§9.2, §10). */
export interface SocketProvisioner {
  socketPathFor(sessionId: SessionId): string
  ensureSocketDir(): void
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
  /** Dormant state-socket provisioner (§9.2, §10 V1 seam). */
  readonly socketProvisioner: SocketProvisioner
  /** The app feature version (§10); gates session-type availability. */
  readonly currentVersion: number
  /**
   * Late-bound sink for a runtime's SPONTANEOUS exit (§6.1). Set by the
   * composition root AFTER the command loop exists, to
   * `(sessionId, …) => loop.dispatch({ kind: 'handleRuntimeExit', … })` — so the
   * `markExited` mutation runs on the single writer, never inline in the PTY
   * callback (§6.6). Mutable by design (chicken-and-egg with the loop).
   */
  onRuntimeExit?: (sessionId: SessionId, exitCode?: number, signal?: number) => void
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
