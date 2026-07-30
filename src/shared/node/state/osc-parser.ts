/**
 * In-band terminal escape-sequence parser (DESIGN §9.1) for the two signals that
 * ride the PTY output byte stream:
 *
 *   - **OSC 133 semantic prompt marks** (Layer 2, structural). Shell-integration
 *     sequences: `OSC 133 ; A ST` (prompt start), `; B` (prompt end / input start),
 *     `; C` (command start / pre-exec), `; D [; <exit>]` (command end). We map
 *     `C` → a command is running (Working) and `A`/`D` → back at the prompt
 *     (Waiting). This is more reliable than tpgid polling for the exact moment of
 *     transition, and Octopus injects OSC 133 into its own terminals (§9.1 baseline,
 *     §12.1) so it is present even without app-specific hooks.
 *   - **OSC 9000 explicit state** (Layer 3, authoritative). Octopus's private OSC:
 *     `OSC 9000 ; <json> ST` where the JSON is `{state,reason?,tool?}`. A program
 *     that knows its own state can emit this directly; the ClaudeCodeProvider's
 *     socket path (§9.2) is the primary Layer-3 source, this is the in-band twin.
 *
 * ## Streaming + O(1)/byte (§11, R2)
 * A socket/PTY delivers arbitrary chunks that split sequences anywhere, so this is
 * a stateful scanner: it holds only a bounded partial-sequence tail between
 * `push()` calls and emits every COMPLETE mark now available. Terminator is BEL
 * (`0x07`) or ST (`ESC \`, `0x1b 0x5c`), per the OSC spec. A runaway sequence with
 * no terminator is capped so a hostile/binary stream can't grow the buffer
 * unboundedly — past the cap we drop the pending sequence and resync.
 *
 * Pure of node types beyond `string`; lives in `shared/node` alongside the daemon
 * protocol because both backends parse output here (§9.6). It must NOT import
 * `domain` (shared convention) — states are plain strings, mapped at the adapter.
 */

/** A decoded OSC 133 semantic mark (§9.1). */
export interface Osc133Mark {
  readonly kind: 'osc133'
  /** A = prompt-start, B = prompt-end, C = command-start, D = command-end. */
  readonly mark: 'A' | 'B' | 'C' | 'D'
  /** Exit code parsed from a `D;<code>` command-end, when present. */
  readonly exitCode?: number
}

/** A decoded OSC 9000 explicit-state payload (§9.1 Layer 3). */
export interface Osc9000State {
  readonly kind: 'osc9000'
  /** One of the known state strings; unknown values are dropped by the parser. */
  readonly state: 'waiting' | 'working' | 'blocked'
  readonly reason?: string
  readonly tool?: string
}

export type OscSignal = Osc133Mark | Osc9000State

const BEL = 0x07
const ESC = 0x1b
const BACKSLASH = 0x5c

/** Cap on a buffered incomplete OSC sequence before we give up and resync (§11). */
const MAX_OSC_BYTES = 4096

/** Longest payload we treat as a candidate OSC 9000 JSON (guards the ≤1 KB rule, §9.2). */
const MAX_OSC9000_JSON = 1024

/**
 * Stateful OSC scanner. Feed it raw output chunks; it returns the semantic signals
 * completed by that chunk. It ONLY tracks OSC (`ESC ]`) sequences — every other
 * byte (including CSI cursor moves, colors, plain text) is passed over cheaply so
 * the hot path stays O(1)/byte.
 */
export class OscParser {
  /** Bytes of an in-progress OSC sequence AFTER the `ESC ]` introducer. */
  private pending = ''
  /** True while inside an OSC sequence (seen `ESC ]`, not yet terminated). */
  private inOsc = false
  /** True when the previous byte was a lone ESC (possible introducer or ST start). */
  private sawEsc = false

  /** Feed a chunk of terminal output; returns any signals it completed. */
  push(chunk: string): OscSignal[] {
    const out: OscSignal[] = []
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i)

      if (this.inOsc) {
        // Terminator 1: BEL.
        if (code === BEL) {
          this.finishOsc(out)
          continue
        }
        // Terminator 2: ST = ESC \. The ESC is swallowed; the backslash ends it.
        if (this.sawEsc) {
          this.sawEsc = false
          if (code === BACKSLASH) {
            this.finishOsc(out)
            continue
          }
          // ESC followed by something else inside an OSC — malformed; keep the
          // ESC-swallowed byte as literal payload and continue accumulating.
          this.pending += String.fromCharCode(code)
          this.capGuard()
          continue
        }
        if (code === ESC) {
          this.sawEsc = true
          continue
        }
        this.pending += chunk[i]
        this.capGuard()
        continue
      }

      // Not in an OSC: look for the `ESC ]` introducer.
      if (this.sawEsc) {
        this.sawEsc = false
        if (code === 0x5d /* ] */) {
          this.inOsc = true
          this.pending = ''
        }
        // Any other ESC-x (CSI `ESC [`, etc.) is not our concern — skip it.
        continue
      }
      if (code === ESC) {
        this.sawEsc = true
      }
    }
    return out
  }

  /** Drop any partial state (used on teardown / after an oversized sequence). */
  reset(): void {
    this.pending = ''
    this.inOsc = false
    this.sawEsc = false
  }

  /** Abort an over-long unterminated sequence so the buffer can't grow forever. */
  private capGuard(): void {
    if (this.pending.length > MAX_OSC_BYTES) {
      this.reset()
    }
  }

  /** A complete OSC payload accumulated in `pending`; decode + emit it. */
  private finishOsc(out: OscSignal[]): void {
    const payload = this.pending
    this.inOsc = false
    this.pending = ''
    const signal = decodeOsc(payload)
    if (signal) {
      out.push(signal)
    }
  }
}

/**
 * Decode one OSC payload (the bytes between `ESC ]` and the terminator) into a
 * signal, or `undefined` if it is not one we care about / is malformed. Exported
 * for direct unit testing of the payload grammar without the streaming scanner.
 */
export function decodeOsc(payload: string): OscSignal | undefined {
  const semi = payload.indexOf(';')
  const psRaw = semi === -1 ? payload : payload.slice(0, semi)
  const ps = Number.parseInt(psRaw, 10)

  if (ps === 133) {
    return decodeOsc133(semi === -1 ? '' : payload.slice(semi + 1))
  }
  if (ps === 9000) {
    return decodeOsc9000(semi === -1 ? '' : payload.slice(semi + 1))
  }
  return undefined
}

/** `A` | `B` | `C` | `D[;<exit>][;...]` → an {@link Osc133Mark}. */
function decodeOsc133(body: string): Osc133Mark | undefined {
  const mark = body.charAt(0)
  if (mark !== 'A' && mark !== 'B' && mark !== 'C' && mark !== 'D') {
    return undefined
  }
  if (mark === 'D') {
    // `D` or `D;<exit>` (further `;k=v` params ignored).
    const parts = body.split(';')
    const code = parts.length > 1 ? Number.parseInt(parts[1], 10) : NaN
    return { kind: 'osc133', mark, exitCode: Number.isInteger(code) ? code : undefined }
  }
  return { kind: 'osc133', mark }
}

/** `<json>` → an {@link Osc9000State}; validated (≤1 KB, known state), §9.2. */
function decodeOsc9000(body: string): Osc9000State | undefined {
  if (body.length === 0 || body.length > MAX_OSC9000_JSON) {
    return undefined
  }
  return parseStateJson(body)
}

/**
 * Validate + parse a Layer-3 state JSON payload (shared by OSC 9000 and the Claude
 * socket, §9.2): ≤1 KB, valid JSON object, a KNOWN state string. Nothing from the
 * payload is ever executed — only `state`/`reason`/`tool` strings are read.
 * Returns `undefined` on any violation (→ graceful degradation to heuristic).
 */
export function parseStateJson(raw: string): Osc9000State | undefined {
  if (raw.length > MAX_OSC9000_JSON) {
    return undefined
  }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof obj !== 'object' || obj === null) {
    return undefined
  }
  const rec = obj as Record<string, unknown>
  const state = rec.state
  if (state !== 'waiting' && state !== 'working' && state !== 'blocked') {
    return undefined
  }
  const reason = typeof rec.reason === 'string' ? rec.reason : undefined
  const tool = typeof rec.tool === 'string' ? rec.tool : undefined
  return { kind: 'osc9000', state, reason, tool }
}
