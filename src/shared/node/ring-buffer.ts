/**
 * Bounded byte-capped ring buffer of terminal output (DESIGN §6.6). Inactive
 * tabs are not sent `ptyData`; their output is appended here and replayed on tab
 * activation, so a session the user hasn't looked at for a while still shows its
 * recent scrollback when switched to.
 *
 * This is load-bearing for the V2 durable backend (§6.2): the `octopusd` daemon
 * keeps a larger server-side buffer replayed on re-attach, but the shape —
 * append, byte-capped, snapshot — is the same. Kept as a simple FIFO of chunks
 * trimmed from the front once the total exceeds the cap; a single oversized chunk
 * is itself truncated to the cap's tail so one giant write can't blow the bound.
 *
 * Lives under `src/shared/node/` (not the browser-safe `src/shared/` root)
 * because it uses `Buffer`: both the in-process adapter and the daemon import it,
 * but the renderer must never pull it into a DOM bundle. `tsconfig.web.json`
 * excludes `src/shared/node/**` for exactly this reason.
 *
 * Pure, no I/O — fully unit-testable.
 */

/**
 * Byte cap of main's per-session scrollback buffer, and of the frozen restored history
 * persisted next to it (§6.6). Deliberately 10x smaller than the daemon's 5 MB ring:
 * every restore path shows at most ~500K characters anyway (`OUTPUT_TAIL_MAX_BYTES`
 * in `src/shared/output-tail.ts` bounds both main's pre-hydration queue and the
 * renderer's pre-mount buffer), so keeping more in main would cost memory and flush
 * time and show nothing more. Raise both together if deeper restored history is wanted.
 */
export const SCROLLBACK_MAX_BYTES = 500 * 1024

const DEFAULT_MAX_BYTES = SCROLLBACK_MAX_BYTES

export class RingBuffer {
  private readonly maxBytes: number
  private chunks: string[] = []
  private totalBytes = 0

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  /** Append a chunk, evicting oldest chunks until within the byte cap. */
  append(data: string): void {
    if (data.length === 0) {
      return
    }
    let chunk = data
    let bytes = Buffer.byteLength(chunk, 'utf8')
    // A single chunk larger than the whole cap: keep only its tail.
    if (bytes > this.maxBytes) {
      chunk = tailBytes(chunk, this.maxBytes)
      bytes = Buffer.byteLength(chunk, 'utf8')
    }
    this.chunks.push(chunk)
    this.totalBytes += bytes
    this.evict()
  }

  /** The retained output as a single string (oldest → newest). */
  snapshot(): string {
    return this.chunks.join('')
  }

  /** Current retained size in bytes (≤ maxBytes). */
  get byteLength(): number {
    return this.totalBytes
  }

  /** Drop all retained output. */
  clear(): void {
    this.chunks = []
    this.totalBytes = 0
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift() as string
      this.totalBytes -= Buffer.byteLength(removed, 'utf8')
    }
  }
}

/**
 * Return the longest suffix of `s` whose UTF-8 size is <= maxBytes. Encodes once and
 * cuts at a UTF-8 character boundary, so it is linear in `s` with a small constant:
 * it runs on every multi-megabyte daemon replay and on every history rotation. A lone
 * surrogate (invalid UTF-16) comes back as U+FFFD, as with any UTF-8 round trip.
 */
export function tailBytes(s: string, maxBytes: number): string {
  if (s.length <= maxBytes / 3) {
    return s // even at 3 bytes per UTF-16 unit it fits; skip the encode
  }
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) {
    return s
  }
  let start = buf.length - Math.max(0, maxBytes)
  // Skip continuation bytes (10xxxxxx) so the cut never splits a character.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++
  }
  return buf.subarray(start).toString('utf8')
}
