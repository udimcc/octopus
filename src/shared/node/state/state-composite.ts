/**
 * `CompositeStateProvider` — the backend-neutral engine that decides one
 * {@link CoreState} per session (DESIGN §9.1). Both backends construct ONE per
 * session where the PTY fd lives (§9.6): the in-process `PtyTerminalRuntime` and,
 * identically, `octopusd`. It emits plain `CoreState` strings; each backend's
 * adapter maps them to the domain `SessionState` (the `shared` layer may not
 * import `domain`).
 *
 * ## Claude-only model (§9)
 * Status reflects ONLY an interactive program that reports its own state — in
 * practice Claude Code via its hooks (§9.2). A plain shell prompt, or any other
 * foreground command, is `unknown` (no icon). The engine fuses just two signals:
 *
 *   - **Structural sentinel** ({@link resolveForeground}, from `/proc/<pid>/stat`):
 *     is the SHELL sitting at its own prompt (`tpgid === pgrp`), or is a child in
 *     the foreground? This is the ONLY thing polled. When the shell is at its
 *     prompt, no tracked program is running → `unknown`, and any stored explicit
 *     signal is cleared.
 *   - **Explicit L3** (authoritative): a canonical `working`/`waiting`/`blocked`
 *     from the Claude socket or an OSC 9000 payload. While a child holds the
 *     foreground, the LAST explicit signal is reported verbatim and NEVER goes
 *     stale — it persists until the next explicit signal or until the shell
 *     returns to its prompt.
 *
 * ## Decision (§9.1)
 *   1. No `/proc` read (dead pid / non-Linux) → `unknown`.
 *   2. Shell at its own prompt → `unknown` (Claude, if any, has exited/suspended;
 *      clear the stored explicit). This is the sentinel for "the tracked program
 *      is gone", and it is robust to Claude's tool subprocesses: while Claude runs
 *      a shell tool the foreground `comm` is `bash`/`git`/… but the shell is NOT at
 *      its prompt, so the last explicit state is held.
 *   3. A child is in the foreground and we have an explicit signal → report it.
 *   4. A child is in the foreground but no explicit signal yet → `unknown` (better
 *      to show nothing than to guess before the first hook fires).
 *
 * ## Timing
 * Explicit transitions are event-driven (socket / OSC) and inherently debounced by
 * discrete hook events, so they emit immediately. The only poll-driven transition
 * is to/from `unknown` as the shell enters/leaves its prompt, which also emits
 * immediately so the icon clears the instant Claude exits. There is no activity
 * timer, no silence heuristic, and no staleness window — the sources of the old
 * "idle Claude flaps to working/needs-input" bug (§9, removed).
 *
 * ## The at-prompt tradeoff
 * An explicit signal that arrives in the same instant the shell is at its prompt is
 * dropped (rule 2 clears it) rather than mapped to a state — we prefer the
 * structural truth "nothing is running" over a straggling hook. In practice the
 * `Stop` hook fires while Claude still owns the foreground, so `Idle` is reported
 * correctly; only a hook racing an actual Claude exit is discarded, which is right.
 */

import { resolveForeground as realResolveForeground, type ForegroundInfo } from './proc-stat'
import { OscParser } from './osc-parser'
import type {
  CoreState,
  CoreStateChange,
  CoreStateEvaluator,
  ExplicitSignal,
  ProgramStateDetectorRegistry
} from './state-core'

/** How long an OSC 133 mark refines the at-prompt read before we defer to tpgid. */
const T_OSC133_MS = 30_000
/** Structural poll cadence (§9.1). */
const POLL_MS = 200

/** Injectable clock/timer surface so the composite is unit-testable without wall time. */
export interface CompositeClock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realClock: CompositeClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}

export interface CompositeOptions {
  /** Shell pid whose `/proc/<pid>/stat` drives the structural sentinel (§9.1). */
  readonly shellPid: number
  /** Pluggable per-program L3 detectors (§9.3) — remap a program's explicit vocabulary. */
  readonly registry: ProgramStateDetectorRegistry
  /** Override the clock/timers in tests. */
  readonly clock?: CompositeClock
  /** Structural poll cadence; defaults to {@link POLL_MS}. */
  readonly pollMs?: number
  /** Override the foreground read in tests (defaults to the real `/proc` resolver). */
  readonly resolveForeground?: (shellPid: number) => ForegroundInfo | undefined
}

interface RawEvaluation {
  readonly state: CoreState
  readonly layer: 1 | 2 | 3
  readonly confidence: CoreStateChange['confidence']
  readonly reason: string
  readonly subState?: string
}

interface StoredExplicit {
  readonly state: CoreState
  readonly reason?: string
}

export class CompositeStateProvider implements CoreStateEvaluator {
  private readonly clock: CompositeClock
  private readonly resolveForeground: (shellPid: number) => ForegroundInfo | undefined
  private readonly osc = new OscParser()
  private listener: ((change: CoreStateChange) => void) | null = null
  private pollHandle: unknown = null

  /** The most recent explicit L3 signal, or null (cleared when the shell is at its prompt). */
  private explicit: StoredExplicit | null = null
  /** Fresh OSC 133 prompt read: true = at prompt (A/D), false = running (C). */
  private osc133AtPrompt: boolean | undefined
  private osc133At = 0

  /** The last EMITTED state (what the subscriber currently believes). */
  private current: CoreState = 'unknown'

  constructor(private readonly opts: CompositeOptions) {
    this.clock = opts.clock ?? realClock
    this.resolveForeground = opts.resolveForeground ?? realResolveForeground
  }

  onStateChange(listener: (change: CoreStateChange) => void): void {
    this.listener = listener
    // Kick the structural poll; the first tick establishes the initial state.
    if (this.pollHandle === null) {
      this.pollHandle = this.clock.setInterval(() => this.evaluate(), this.opts.pollMs ?? POLL_MS)
    }
    this.evaluate()
  }

  feedOutput(data: string): void {
    if (data.length === 0) {
      return
    }
    const signals = this.osc.push(data)
    let sawExplicit = false
    for (const sig of signals) {
      if (sig.kind === 'osc133') {
        // A = prompt-start, D = command-end ⇒ at prompt; C = command-start ⇒ running.
        // B (prompt-end / input-start) is ambiguous on its own — leave the read as-is.
        if (sig.mark === 'A' || sig.mark === 'D') {
          this.osc133AtPrompt = true
          this.osc133At = this.clock.now()
        } else if (sig.mark === 'C') {
          this.osc133AtPrompt = false
          this.osc133At = this.clock.now()
        }
      } else {
        // OSC 9000 explicit state (in-band L3 twin of the socket).
        this.submitExplicit({ state: sig.state, reason: sig.reason, tool: sig.tool })
        sawExplicit = true
      }
    }
    // An explicit signal can flip state immediately; a bare OSC 133 mark waits for
    // the next poll so the hot path doesn't read /proc on every chunk.
    if (sawExplicit) {
      this.evaluate()
    }
  }

  /**
   * Ingest a canonical L3 signal from an out-of-band source (the Claude socket,
   * §9.2). Acceptance is NOT gated on the foreground `comm` — during a Claude tool
   * call the foreground is `bash`/`git`/… yet the signal is still Claude's. The
   * signal is remapped through the detector matched to the current foreground
   * program (identity for Claude, and identity too when no detector matches), then
   * stored; the at-prompt sentinel in {@link evaluateRaw} is what suppresses it once
   * the tracked program is gone.
   */
  submitExplicit(signal: ExplicitSignal): void {
    const fg = this.resolveForeground(this.opts.shellPid)
    const detector = this.opts.registry.forComm(fg?.comm)
    const mapped = detector ? detector.interpret(signal) : signal.state
    if (mapped === undefined) {
      return
    }
    this.explicit = { state: mapped, reason: signal.reason }
    this.evaluate()
  }

  refresh(): void {
    this.evaluate()
  }

  dispose(): void {
    if (this.pollHandle !== null) {
      this.clock.clearInterval(this.pollHandle)
      this.pollHandle = null
    }
    this.listener = null
    this.osc.reset()
  }

  // --- internals -----------------------------------------------------------

  /** Compute the raw state from the sentinel + the stored explicit signal (§9.1). */
  private evaluateRaw(now: number): RawEvaluation {
    const fg = this.resolveForeground(this.opts.shellPid)
    if (!fg) {
      // No /proc read (dead pid / non-Linux) — nothing to report.
      return { state: 'unknown', layer: 2, confidence: 'none', reason: 'no_proc' }
    }

    const osc133Fresh = this.osc133AtPrompt !== undefined && now - this.osc133At <= T_OSC133_MS
    const atPrompt = osc133Fresh ? (this.osc133AtPrompt as boolean) : fg.atPrompt

    if (atPrompt) {
      // The shell owns the terminal foreground: the tracked program (if any) has
      // exited or been suspended. Clear the sticky explicit so a later foreground
      // program starts from a clean slate, and report nothing.
      this.explicit = null
      return { state: 'unknown', layer: 2, confidence: 'high', reason: 'at_prompt' }
    }

    // A child is in the foreground (Claude, or a subprocess it launched). Report the
    // last explicit signal verbatim; it never goes stale while a child runs.
    if (this.explicit) {
      return {
        state: this.explicit.state,
        layer: 3,
        confidence: 'authoritative',
        reason: this.explicit.reason ?? 'explicit',
        subState: fg.comm
      }
    }

    // A child is running but hasn't reported its state yet — show nothing rather
    // than guess (the first hook signal arrives within ~one poll).
    return { state: 'unknown', layer: 2, confidence: 'medium', reason: 'no_explicit_yet' }
  }

  /**
   * Evaluate and emit on any change. Every transition is immediate: explicit
   * signals are already debounced by discrete hook events, and the to/from-`unknown`
   * sentinel must clear the icon the instant Claude exits.
   */
  private evaluate(): void {
    if (!this.listener) {
      return
    }
    const raw = this.evaluateRaw(this.clock.now())
    if (raw.state === this.current && this.current !== 'unknown') {
      return
    }
    // The very first evaluation (still `unknown`) with a `raw` of `unknown` should
    // not emit — nothing has changed and no icon is wanted.
    if (raw.state === this.current) {
      return
    }
    this.emit(raw)
  }

  private emit(raw: RawEvaluation): void {
    this.current = raw.state
    this.listener?.({
      state: raw.state,
      layer: raw.layer,
      confidence: raw.confidence,
      reason: raw.reason,
      subState: raw.subState
    })
  }
}
