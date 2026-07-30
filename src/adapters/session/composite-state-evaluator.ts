/**
 * Adapter edge that turns the backend-neutral {@link CompositeStateProvider} (shared,
 * plain `CoreState` strings) into the ports {@link StateEvaluator} the Application
 * subscribes to — mapping `CoreState` → the domain {@link SessionState} and the
 * composite's layer/confidence/reason into {@link StateChangeMeta} (DESIGN §9.6).
 * This is where the `shared`-may-not-import-`domain` rule is honored: the mapping
 * happens HERE, in an adapter, not in the shared core.
 *
 * It also owns the Layer-3 socket (§9.2): it binds `$OCTOPUS_STATE_SOCKET` via
 * {@link bindStateSocket} and forwards each validated frame into the composite's
 * `submitExplicit`. Used by the in-process `PtyTerminalRuntime`; the daemon builds
 * the identical composite inside `octopusd` and surfaces its output over the
 * `state` control frame instead (§9.6), so both backends share this exact fusion
 * logic and differ only in transport.
 */

import type { StateEvaluator, StateChangeMeta } from '../../ports/session-runtime'
import { SessionState, SessionSubState } from '../../domain/state'
import { CompositeStateProvider, type CompositeClock } from '../../shared/node/state/state-composite'
import { bindStateSocket, type StateSocketListener } from '../../shared/node/state/state-socket-listener'
import type {
  CoreState,
  CoreStateChange,
  ProgramStateDetectorRegistry
} from '../../shared/node/state/state-core'

/** Map the shared plain-string state to the domain enum (the values are equal). */
export function coreToSessionState(state: CoreState): SessionState {
  switch (state) {
    case 'waiting':
      return SessionState.Idle
    case 'working':
      return SessionState.Working
    case 'blocked':
      return SessionState.NeedsInput
    case 'unknown':
      return SessionState.Unknown
  }
}

/**
 * Best-effort map of the composite's `reason`/`subState` into the internal
 * {@link SessionSubState} (§3.3) carried in {@link StateChangeMeta} for the debug
 * overlay. Only the reasons the composite actually emits are mapped; anything else
 * is left undefined (the aggregation lattice needs only the top-level state).
 */
function toSubState(change: CoreStateChange): SessionSubState | undefined {
  if (change.reason === 'at_prompt') {
    return SessionSubState.WaitingAtPrompt
  }
  if (change.layer === 3) {
    if (change.state === 'waiting') return SessionSubState.WaitingExplicit
    if (change.state === 'working') return SessionSubState.WorkingExplicit
    if (change.state === 'blocked') return SessionSubState.BlockedExplicit
  }
  return undefined
}

export interface CompositeStateEvaluatorOptions {
  readonly shellPid: number
  readonly registry: ProgramStateDetectorRegistry
  /** The per-session L3 socket to bind (§9.2); omitted ⇒ structural sentinel only (always Unknown). */
  readonly stateSocketPath?: string
  readonly clock?: CompositeClock
}

/**
 * The concrete ports {@link StateEvaluator} for a PTY-backed session. Wraps a
 * {@link CompositeStateProvider}, binds the L3 socket, and exposes `feedOutput` so
 * the runtime can tee raw PTY output into the OSC parser.
 */
export class CompositeStateEvaluator implements StateEvaluator {
  private readonly composite: CompositeStateProvider
  private readonly socket?: StateSocketListener

  constructor(opts: CompositeStateEvaluatorOptions) {
    this.composite = new CompositeStateProvider({
      shellPid: opts.shellPid,
      registry: opts.registry,
      clock: opts.clock
    })
    if (opts.stateSocketPath) {
      this.socket = bindStateSocket(opts.stateSocketPath, (signal) =>
        this.composite.submitExplicit(signal)
      )
    }
  }

  onStateChange(listener: (state: SessionState, meta?: StateChangeMeta) => void): void {
    this.composite.onStateChange((change) => {
      listener(coreToSessionState(change.state), {
        subState: toSubState(change),
        layer: change.layer,
        confidence: change.confidence,
        reason: change.reason
      })
    })
  }

  /** Tee of raw PTY output — drives OSC parsing + activity timing (§9.1). */
  feedOutput(data: string): void {
    this.composite.feedOutput(data)
  }

  refresh(): void {
    this.composite.refresh()
  }

  dispose(): void {
    this.composite.dispose()
    this.socket?.close()
  }
}
