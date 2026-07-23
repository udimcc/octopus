/**
 * Bounded byte-capped ring buffer of terminal output (DESIGN §6.6). Inactive
 * tabs are not sent `ptyData`; their output is appended here and replayed on tab
 * activation, so a session the user hasn't looked at for a while still shows its
 * recent scrollback when switched to.
 *
 * This is load-bearing for the V2 durable backend (§6.2): the daemon keeps a
 * larger server-side buffer replayed on re-attach, but the shape — append,
 * byte-capped, snapshot — is the same. Kept as a simple FIFO of chunks trimmed
 * from the front once the total exceeds the cap; a single oversized chunk is
 * itself truncated to the cap's tail so one giant write can't blow the bound.
 *
 * Pure, no I/O — fully unit-testable.
 */

const DEFAULT_MAX_BYTES = 500 * 1024

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

/** Return the longest suffix of `s` whose UTF-8 size is ≤ maxBytes. */
function tailBytes(s: string, maxBytes: number): string {
  // Walk back from the end accumulating byte cost; cheap enough for the rare
  // oversized-chunk path and avoids splitting a multibyte char mid-sequence.
  let bytes = 0
  let i = s.length
  while (i > 0) {
    const chBytes = Buffer.byteLength(s[i - 1], 'utf8')
    if (bytes + chBytes > maxBytes) {
      break
    }
    bytes += chBytes
    i--
  }
  return s.slice(i)
}
