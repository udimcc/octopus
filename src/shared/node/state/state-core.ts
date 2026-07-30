/**
 * The transport-neutral core of the session-state-detection subsystem
 * (DESIGN §9.1–§9.3, §9.6). Lives in `shared/node` because BOTH backends run the
 * exact same detection logic where the PTY fd lives (§9.6): Electron main for the
 * in-process runtime, and inside `octopusd` for the daemon backend. Neither may
 * import the other; `shared` may not import `domain`, so states are plain strings
 * here — each backend's adapter maps `CoreState` → the domain `SessionState`
 * (the same convention `daemon-protocol.ts` uses for ids).
 *
 * This file holds the small value types plus the **pluggable per-program detector
 * registry** (§9.3): which Layer-3 detector's vocabulary is applied to an explicit
 * signal is chosen from the foreground program's `comm`, NOT hard-wired to Claude.
 * Phase 2 registers one real entry (`claude`) + an implicit default ("no detector"
 * ⇒ the signal is trusted verbatim). Adding a program is a new `register()` at the
 * composition root — zero change to the composite, aggregator, icons, or ports (the
 * §8 additive rule). Status is Claude-only (§9): a foreground program with no
 * explicit signal stays `unknown`; there is no activity/silence heuristic.
 */

/** The four states, as plain strings equal to the domain `SessionState` values. */
export type CoreState = 'unknown' | 'waiting' | 'working' | 'blocked'

/** Confidence bands (§9.3); the UI dims medium/low. */
export type CoreConfidence = 'authoritative' | 'high' | 'medium' | 'low' | 'none'

/** A single evaluated state change pushed to the subscriber. */
export interface CoreStateChange {
  readonly state: CoreState
  /** Which signal layer decided this (§9.1): 1 = activity, 2 = structural, 3 = explicit. */
  readonly layer?: 1 | 2 | 3
  readonly confidence?: CoreConfidence
  /** Free-form reason for the transition log (R1). */
  readonly reason?: string
  /** Internal sub-state string (§3.3), for the debug overlay. */
  readonly subState?: string
}

/**
 * The backend-neutral evaluator both runtimes drive (§9.6). It OWNS its timers /
 * OSC parsing / socket internally; the backend only feeds it PTY output and
 * subscribes. States are `CoreState` strings; the adapter maps them.
 */
export interface CoreStateEvaluator {
  /** Register the single change sink; the latest state is pushed on every transition. */
  onStateChange(listener: (change: CoreStateChange) => void): void
  /** Feed a chunk of raw PTY output (drives OSC parsing + activity timing). */
  feedOutput(data: string): void
  /** Force an immediate re-evaluation (the manual "refresh state" affordance, R1). */
  refresh(): void
  /** Stop all timers/listeners. */
  dispose(): void
}

/** A raw Layer-3 explicit signal (from the Claude socket or an OSC 9000 payload). */
export interface ExplicitSignal {
  readonly state: 'waiting' | 'working' | 'blocked'
  readonly reason?: string
  readonly tool?: string
}

/**
 * A pluggable per-program Layer-3 detector (§9.3). The composite selects the one
 * whose `matches(comm)` is true for the current foreground program; `undefined`
 * (no match) means the implicit default — Layer-2 heuristic only.
 */
export interface ProgramStateDetector {
  /** Human/debug name (also the transition-log tag). */
  readonly name: string
  /** True when this detector governs a foreground program named `comm`. */
  matches(comm: string): boolean
  /**
   * Interpret a raw explicit signal for THIS program → a `CoreState`, or
   * `undefined` to ignore it. Lets a program remap its own vocabulary (e.g. a build
   * tool's OSC 9000) without the composite knowing the specifics.
   */
  interpret(signal: ExplicitSignal): CoreState | undefined
}

export interface ProgramStateDetectorRegistry {
  register(detector: ProgramStateDetector): void
  /** The detector matching `comm`, or `undefined` for the default (trust the signal verbatim). */
  forComm(comm: string | undefined): ProgramStateDetector | undefined
}

/** First-match-wins registry (§9.3). Order = registration order. */
export class InMemoryProgramStateDetectorRegistry implements ProgramStateDetectorRegistry {
  private readonly detectors: ProgramStateDetector[] = []

  register(detector: ProgramStateDetector): void {
    this.detectors.push(detector)
  }

  forComm(comm: string | undefined): ProgramStateDetector | undefined {
    if (comm === undefined) {
      return undefined
    }
    return this.detectors.find((d) => d.matches(comm))
  }
}

/**
 * The Claude Code Layer-3 detector (§9.2). Matches the `claude` foreground `comm`
 * and trusts its explicit signals verbatim (the hooks emit `waiting`/`working`/
 * `blocked` directly, §9.2). `Notification` → `blocked` is Claude's authoritative
 * "needs the user" signal; there is no silence heuristic backstop (§9, removed).
 *
 * `comm` matching is tolerant: node-pty may report the wrapper (`claude`) or, on
 * some installs, the interpreter (`node`). We match an exact `claude` and a
 * `claude`-prefixed comm (the kernel truncates `comm` to 15 chars); a `node`
 * wrapper is covered by the socket signal being authoritative regardless of comm
 * (the composite honors a fresh explicit signal on any foreground).
 */
export class ClaudeCodeDetector implements ProgramStateDetector {
  readonly name = 'claude'

  matches(comm: string): boolean {
    const c = comm.toLowerCase()
    return c === 'claude' || c.startsWith('claude')
  }

  interpret(signal: ExplicitSignal): CoreState {
    return signal.state
  }
}

/** Build the phase-2 registry: exactly `claude` + the implicit default (§9.3). */
export function createDefaultDetectorRegistry(): ProgramStateDetectorRegistry {
  const registry = new InMemoryProgramStateDetectorRegistry()
  registry.register(new ClaudeCodeDetector())
  return registry
}
