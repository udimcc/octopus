/**
 * One live PTY owned by the `octopusd` daemon (DESIGN §6.2). The daemon-side
 * analog of `PtyTerminalRuntime`: it spawns node-pty, batches output server-side
 * (so coalescing happens BEFORE the socket hop), keeps a large server-side ring
 * buffer for replay-on-attach, and reproduces the SPONTANEOUS-vs-`close` exit
 * discrimination the in-process runtime relies on (the `stopping` flag).
 *
 * It takes an INJECTED `spawn` (the narrow {@link DaemonPtySpawn}) so this logic
 * is unit-testable with a fake PTY and no native module — mirroring how
 * `pty-terminal-runtime.ts` injects its spawn. The one real node-pty value-import
 * lives in `pty-registry.ts`.
 *
 * A `DaemonPty` has AT MOST ONE attached client at a time (the app). Output is
 * always appended to the ring buffer; it is streamed to the client only while
 * one is attached. On (re-)attach the buffer snapshot is replayed first, then live
 * output resumes — this is what carries a `vim`/Claude session across an app
 * restart intact (§6.2).
 */

import { OutputBatcher } from '../shared/node/output-batcher'
import { RingBuffer } from '../shared/node/ring-buffer'
import { CompositeStateProvider } from '../shared/node/state/state-composite'
import { bindStateSocket, type StateSocketListener } from '../shared/node/state/state-socket-listener'
import type {
  CoreStateChange,
  ProgramStateDetectorRegistry
} from '../shared/node/state/state-core'

/** A disposable listener registration (node-pty's IDisposable shape). */
export interface DaemonPtyDisposable {
  dispose(): void
}

/** The narrow slice of node-pty's `IPty` the daemon uses. */
export interface DaemonPtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): DaemonPtyDisposable
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): DaemonPtyDisposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface DaemonPtySpawnOptions {
  readonly name: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: Record<string, string>
}

/** Narrow spawn signature; node-pty's `spawn` is assignable to it. */
export type DaemonPtySpawn = (
  file: string,
  args: string[],
  options: DaemonPtySpawnOptions
) => DaemonPtyProcess

export interface DaemonPtyOptions {
  readonly spawn: DaemonPtySpawn
  readonly shell: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
  /** Server-side ring-buffer cap (default ~5 MB, §6.2). */
  readonly bufferBytes?: number
  /** SIGHUP→SIGKILL grace period on close (default 2000 ms, §6.1). */
  readonly graceMs?: number
  /** Injected timer (default globals); lets tests drive the grace timer + batcher. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
  /**
   * Pluggable per-program state detectors (§9.3). When present, the daemon builds
   * the SAME {@link CompositeStateProvider} the in-process backend uses and reports
   * every debounced transition through the sink's `onState`. Omitted ⇒ no detection
   * (the client then simply never receives `state` frames for this session).
   */
  readonly detectorRegistry?: ProgramStateDetectorRegistry
  /** Per-session L3 state socket to bind (§9.2); omitted ⇒ L2/L1 only. */
  readonly stateSocketPath?: string
}

const DEFAULT_BUFFER_BYTES = 5 * 1024 * 1024
const DEFAULT_GRACE_MS = 2000

/** Callbacks the registry wires so it can broadcast to the attached client. */
export interface DaemonPtySink {
  /** Batched live output for this session. */
  onData(data: string): void
  /** SPONTANEOUS death only (a `close()` resolves via its own path, no onExit). */
  onExit(exitCode: number, signal?: number): void
  /**
   * An evaluated state change (§9.6), pushed on every debounced transition. Wired
   * only when a detector registry is present; the server forwards it as a `state`
   * control frame. Optional so a sink that ignores state (e.g. a test) can omit it.
   */
  onState?(change: CoreStateChange): void
}

export class DaemonPty {
  readonly cols: number
  readonly rows: number

  private readonly pty: DaemonPtyProcess
  private readonly buffer: RingBuffer
  private readonly batcher: OutputBatcher
  private readonly graceMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void

  private sink: DaemonPtySink | null = null
  private curCols: number
  private curRows: number
  private exited = false
  private stopping = false
  private lastExit: { exitCode: number; signal?: number } | null = null
  private closeResolvers: Array<() => void> = []
  private evaluator: CompositeStateProvider | null = null
  private stateSocket: StateSocketListener | null = null
  /** The last evaluated state, replayed to a client on (re-)attach (§9.6). */
  private lastState: CoreStateChange | null = null

  constructor(opts: DaemonPtyOptions) {
    this.cols = opts.cols
    this.rows = opts.rows
    this.curCols = opts.cols
    this.curRows = opts.rows
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.buffer = new RingBuffer(opts.bufferBytes ?? DEFAULT_BUFFER_BYTES)
    this.batcher = new OutputBatcher((data) => {
      // Retain for replay-on-attach, then push to a live client if attached.
      this.buffer.append(data)
      this.sink?.onData(data)
    })

    this.pty = opts.spawn(opts.shell, [...opts.args], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env
    })

    // State detection (§9.6): the daemon runs the IDENTICAL composite where its PTY
    // lives, reading /proc/<pid>/stat for Layer 2. Built after spawn so the pid is
    // known. Latest state is remembered and pushed to the sink on every transition.
    if (opts.detectorRegistry) {
      this.evaluator = new CompositeStateProvider({
        shellPid: this.pty.pid,
        registry: opts.detectorRegistry
      })
      this.evaluator.onStateChange((change) => {
        this.lastState = change
        this.sink?.onState?.(change)
      })
      if (opts.stateSocketPath) {
        this.stateSocket = bindStateSocket(opts.stateSocketPath, (signal) =>
          this.evaluator?.submitExplicit(signal)
        )
      }
    }

    // Tee raw (un-batched) output into the evaluator so OSC marks + activity timing
    // see bytes as they arrive, independent of the batching cadence (§9.1).
    this.pty.onData((data) => {
      this.batcher.push(data)
      this.evaluator?.feedOutput(data)
    })
    this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal))
  }

  get pid(): number {
    return this.pty.pid
  }

  get alive(): boolean {
    return !this.exited
  }

  get currentCols(): number {
    return this.curCols
  }

  get currentRows(): number {
    return this.curRows
  }

  /**
   * Attach a client: replay the retained buffer synchronously via the sink's
   * onData, then stream live output. Replaces any prior sink (one client at a time).
   * Returns whether the session is still alive.
   */
  attach(sink: DaemonPtySink): boolean {
    this.sink = sink
    const snapshot = this.buffer.snapshot()
    if (snapshot.length > 0) {
      sink.onData(snapshot)
    }
    // Replay the last evaluated state so a re-attaching client's icon is correct
    // immediately, without waiting for the next transition (§9.6).
    if (this.lastState) {
      sink.onState?.(this.lastState)
    }
    return !this.exited
  }

  /** Force the evaluator to re-emit now (the client's "refresh state", §9.6). */
  refreshState(): void {
    this.evaluator?.refresh()
  }

  /** Detach the current client; the PTY keeps running and buffering (§6.2). */
  detach(): void {
    this.sink = null
  }

  write(data: string): void {
    if (!this.exited) {
      this.pty.write(data)
    }
  }

  resize(cols: number, rows: number): void {
    this.curCols = cols
    this.curRows = rows
    if (this.exited) {
      return
    }
    try {
      this.pty.resize(cols, rows)
    } catch {
      // The process is gone; onExit will (or has) fired.
    }
  }

  /**
   * Graceful close (§6.1): SIGHUP, then SIGKILL after the grace period. Sets the
   * `stopping` flag so the resulting death is reported as `closed`, NOT a
   * spontaneous `exit` (mirrors `PtyTerminalRuntime`). Resolves once the process is
   * confirmed dead or the grace SIGKILL has been sent.
   */
  close(): Promise<void> {
    if (this.exited) {
      return Promise.resolve()
    }
    this.stopping = true
    return new Promise<void>((resolve) => {
      this.closeResolvers.push(resolve)
      try {
        this.pty.kill('SIGHUP')
      } catch {
        this.settleClose()
        return
      }
      const timer = this.setTimer(() => {
        try {
          this.pty.kill('SIGKILL')
        } catch {
          // ignore
        }
        this.settleClose()
      }, this.graceMs)
      this.closeResolvers.push(() => this.clearTimer(timer))
    })
  }

  private handleExit(exitCode: number, signal?: number): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.lastExit = { exitCode, signal }
    // Flush any final buffered output so a late attach still sees it.
    this.batcher.flush()
    // Stop evaluating a dead pid and release its L3 socket (§9.6).
    this.evaluator?.dispose()
    this.stateSocket?.close()
    this.settleClose()
    // A `close()` owns its own resolution; only a SPONTANEOUS death fires onExit.
    if (!this.stopping) {
      this.sink?.onExit(exitCode, signal)
    }
  }

  private settleClose(): void {
    const resolvers = this.closeResolvers
    this.closeResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }

  /** The recorded exit, if the process has died (for late `listSessions` fidelity). */
  get exitInfo(): { exitCode: number; signal?: number } | null {
    return this.lastExit
  }
}
