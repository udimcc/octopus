/**
 * Transport-agnostic wire protocol for the `octopusd` durable-session daemon
 * (DESIGN §6.2). Mirrors the spirit of `src/shared/ipc.ts`: the message set lives
 * in `shared` so BOTH ends — the daemon (`src/daemon/**`) and the main-side
 * `DaemonSessionManager` adapter (`src/adapters/session/**`) — import the exact
 * same types and codec, and neither reaches into the other's layer.
 *
 * Lives under `src/shared/node/` (not the browser-safe `shared` root) because the
 * framing codec uses `Buffer`; the renderer never speaks this protocol.
 *
 * ## Framing
 * A raw socket is a byte stream with no message boundaries, so every message is
 * length-prefixed: `[uint32 BE payload length][1-byte kind][payload]`.
 *   - kind CONTROL (0x01): payload is UTF-8 JSON of a {@link ControlMessage}.
 *   - kind DATA    (0x02): payload is `[uint16 BE sessionId len][sessionId utf8]
 *     [raw terminal bytes]`. Used for the two hottest paths — `write`
 *     (client→daemon keystrokes) and `data` (daemon→client output) — so
 *     high-frequency terminal bytes are NOT base64-inflated (~33%) as they would
 *     be inside JSON (§11 <5 ms budget, §6.2 ~5 MB buffers). Direction is implicit
 *     from the peer: a daemon reading a DATA frame treats it as `write`, a client
 *     reading one treats it as `data`.
 *
 * ## Correlation
 * Request/reply commands carry a `requestId`; the daemon echoes it on the matching
 * reply so the client can resolve the right promise. Unsolicited events (`data`,
 * `exit`) carry none.
 */

/**
 * Bumped when the wire format changes incompatibly; checked in the `hello` handshake.
 *
 * Because `octopusd` is DETACHED and durable (§6.2) it outlives not just an app
 * restart but a rebuild: a daemon spawned by a pre-upgrade build keeps holding the
 * per-uid socket, and the next app launch CONNECTS to it rather than spawning a
 * fresh one. So every protocol addition must bump this — otherwise a stale daemon
 * running old code passes the handshake and silently omits the new behavior.
 *
 * - v1: initial spawn/attach/detach/resize/close/exit/data protocol.
 * - v2 (Phase 2, §9.6): added the unsolicited `state` frame and the `refreshState`
 *   command. A v1 daemon speaks the same core protocol but NEVER emits `state`, so
 *   its sessions would show no status icon. Bumping forces the handshake to reject
 *   it; the app then relaunches a fresh (v2) daemon — or falls back to in-process,
 *   which runs the identical composite and does emit state.
 */
export const PROTOCOL_VERSION = 2

/** Frame kind discriminator (first byte after the length prefix). */
export const FRAME_KIND = { control: 0x01, data: 0x02 } as const

/** 4-byte length prefix + 1-byte kind. */
const HEADER_BYTES = 5

/**
 * Hard cap on a single frame's payload (16 MiB). A corrupt/hostile stream that
 * declares a huge length must not make us buffer unboundedly — decoding throws
 * instead. Well above any real control message or batched terminal chunk.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/** A live session's roster entry, returned by `listSessions` (the re-attach set). */
export interface DaemonSessionInfo {
  readonly sessionId: string
  readonly alive: boolean
  readonly pid: number
  /** Current working directory (from /proc/<pid>/cwd), if resolvable. */
  readonly cwd?: string
  readonly cols: number
  readonly rows: number
}

/** Everything the daemon needs to spawn one PTY. Ids/paths are plain strings (shared convention). */
export interface SpawnParams {
  readonly sessionId: string
  readonly taskId: string
  /** Fully-resolved shell (the main side runs `resolveShell`, which needs settings). */
  readonly shell: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  /** Provisioned-not-bound state socket path (§9.2 seam), forwarded into the child env. */
  readonly stateSocketPath?: string
  /**
   * Extra env layered onto the daemon-built child env (§12.1) — e.g. `ZDOTDIR` /
   * `OCTOPUS_USER_BASHRC` for OSC 133 shell integration. Applied last so it wins.
   * Absent ⇒ no extra env (a plain login shell, or the user opted out).
   */
  readonly envPatch?: Readonly<Record<string, string>>
}

/** Commands the client (app) sends to the daemon. */
export type ClientMessage =
  | { readonly type: 'hello'; readonly requestId: number; readonly protocolVersion: number }
  | { readonly type: 'listSessions'; readonly requestId: number }
  | { readonly type: 'spawn'; readonly requestId: number; readonly params: SpawnParams }
  | { readonly type: 'attach'; readonly requestId: number; readonly sessionId: string }
  | { readonly type: 'detach'; readonly sessionId: string }
  | { readonly type: 'resize'; readonly sessionId: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'close'; readonly requestId: number; readonly sessionId: string }
  | { readonly type: 'shutdown'; readonly requestId: number }
  /**
   * Ask the daemon to re-evaluate a session's state now and push a fresh `state`
   * frame (the "refresh state" affordance, §9.6/§5.4). Fire-and-forget like
   * `resize`/`detach` — no requestId; the answer arrives as an unsolicited `state`.
   */
  | { readonly type: 'refreshState'; readonly sessionId: string }

/** Replies + events the daemon sends to the client. */
export type DaemonMessage =
  | {
      readonly type: 'helloAck'
      readonly requestId: number
      readonly protocolVersion: number
      readonly daemonVersion: string
      /**
       * The daemon's own pid (§6.2). Lets a connecting app RETIRE an incompatible
       * daemon left by a pre-upgrade build: on a `protocolVersion` mismatch the app
       * signals this pid, waits for the socket to free, then launches a fresh daemon.
       * Optional so a v1 daemon (which never sends it) still parses — its absence
       * simply means the app can't auto-restart it and degrades to in-process.
       */
      readonly pid?: number
    }
  | { readonly type: 'sessions'; readonly requestId: number; readonly sessions: readonly DaemonSessionInfo[] }
  | { readonly type: 'spawned'; readonly requestId: number; readonly sessionId: string; readonly pid: number }
  | { readonly type: 'spawnError'; readonly requestId: number; readonly sessionId: string; readonly message: string }
  | { readonly type: 'attached'; readonly requestId: number; readonly sessionId: string; readonly alive: boolean }
  | { readonly type: 'closed'; readonly requestId: number; readonly sessionId: string }
  | { readonly type: 'shutdownAck'; readonly requestId: number; readonly accepted: boolean }
  /** Spontaneous process death (NOT caused by a `close`); routes to `ctx.onExit`. */
  | { readonly type: 'exit'; readonly sessionId: string; readonly exitCode: number; readonly signal?: number }
  /**
   * An evaluated session-state change (§9.6). Unsolicited like `exit`: the daemon
   * runs the SAME {@link CompositeStateProvider} where its PTYs live and pushes a
   * frame on every debounced transition, so the app's `DaemonSessionRuntime`
   * surfaces it through `stateEvaluator()` identically to the in-process backend.
   * `state` is the plain `CoreState` string (mapped to the domain enum main-side);
   * layer/confidence/reason are the same optional debug metadata as §9.1/§9.3.
   */
  | {
      readonly type: 'state'
      readonly sessionId: string
      readonly state: 'unknown' | 'waiting' | 'working' | 'blocked'
      readonly layer?: 1 | 2 | 3
      readonly confidence?: 'authoritative' | 'high' | 'medium' | 'low' | 'none'
      readonly reason?: string
      readonly subState?: string
    }

/** Any JSON control-frame message, either direction. */
export type ControlMessage = ClientMessage | DaemonMessage

/** A decoded frame: either a JSON control message or a per-session terminal-bytes frame. */
export type Frame =
  | { readonly kind: 'control'; readonly message: ControlMessage }
  | { readonly kind: 'data'; readonly sessionId: string; readonly data: string }

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Encode a JSON control message into a length-prefixed CONTROL frame. */
export function encodeControl(message: ControlMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  return frame(FRAME_KIND.control, payload)
}

/**
 * Encode a per-session terminal-bytes DATA frame (used for both `write` and
 * `data`). Payload = uint16 sessionId length + sessionId + raw UTF-8 terminal
 * bytes.
 */
export function encodeData(sessionId: string, data: string): Buffer {
  const idBytes = Buffer.from(sessionId, 'utf8')
  const dataBytes = Buffer.from(data, 'utf8')
  const payload = Buffer.allocUnsafe(2 + idBytes.length + dataBytes.length)
  payload.writeUInt16BE(idBytes.length, 0)
  idBytes.copy(payload, 2)
  dataBytes.copy(payload, 2 + idBytes.length)
  return frame(FRAME_KIND.data, payload)
}

function frame(kind: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  out.writeUInt32BE(payload.length, 0)
  out.writeUInt8(kind, 4)
  payload.copy(out, HEADER_BYTES)
  return out
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Stateful frame reassembler. A socket delivers arbitrary byte chunks that may
 * split or merge frames; `push` accumulates them and returns every COMPLETE frame
 * now available (possibly zero, possibly several), retaining any partial tail for
 * the next call.
 *
 * Throws on a frame whose declared length exceeds {@link MAX_FRAME_BYTES} or on an
 * unknown kind byte — a corrupt stream is a fatal protocol error, not silently
 * skipped.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const frames: Frame[] = []
    while (this.buf.length >= HEADER_BYTES) {
      const len = this.buf.readUInt32BE(0)
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`daemon-protocol: frame length ${len} exceeds cap ${MAX_FRAME_BYTES}`)
      }
      const total = HEADER_BYTES + len
      if (this.buf.length < total) {
        break // partial frame — wait for more bytes
      }
      const kind = this.buf.readUInt8(4)
      const payload = this.buf.subarray(HEADER_BYTES, total)
      frames.push(decodePayload(kind, payload))
      this.buf = this.buf.subarray(total)
    }
    return frames
  }
}

function decodePayload(kind: number, payload: Buffer): Frame {
  if (kind === FRAME_KIND.control) {
    return { kind: 'control', message: JSON.parse(payload.toString('utf8')) as ControlMessage }
  }
  if (kind === FRAME_KIND.data) {
    const idLen = payload.readUInt16BE(0)
    const sessionId = payload.toString('utf8', 2, 2 + idLen)
    const data = payload.toString('utf8', 2 + idLen)
    return { kind: 'data', sessionId, data }
  }
  throw new Error(`daemon-protocol: unknown frame kind 0x${kind.toString(16)}`)
}
