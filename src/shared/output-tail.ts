/**
 * A bounded, **tail-preserving** accumulator for terminal output that has nowhere to
 * go yet (DESIGN §6.2/§6.7).
 *
 * Two places in the app hold output for a short while and must bound it: the main
 * process's per-window pre-hydration queue (`window-registry.ts`) and the renderer's
 * per-session pre-mount buffer (`pty/pty-router.ts`). Both used to bound by *dropping
 * whole chunks, oldest first* — which silently destroys exactly the data it exists to
 * protect: on daemon re-attach the backend replays a session's entire ring buffer as
 * ONE chunk (megabytes), so that single chunk already fills the cap and the very next
 * byte of live output evicts all of the restored history.
 *
 * So the invariant here is stated in BYTES, not chunks: after `append`, the retained
 * content is exactly the newest `min(total, max)` units of the concatenated stream,
 * regardless of how it was chunked. The oldest chunk is trimmed in place rather than
 * discarded whole.
 *
 * Truncation can behead an escape sequence or split a surrogate pair; xterm's parser
 * resynchronizes on the next one. That is the right trade against holding a full ring
 * buffer × every un-mounted session in a renderer (or, worse, in main).
 *
 * Sizes are counted in UTF-16 code units (`string.length`), not UTF-8 bytes as the
 * backend `RingBuffer` counts — a deliberate approximation: it never *under*-estimates
 * for ASCII-dominant terminal output, and the point is a bound, not an exact figure.
 */

/**
 * Default bound per session (~500 KB). Independent of (and 10× smaller than) the
 * backend `RingBuffer` default of 5 MB per session: the daemon buys deep scrollback
 * for re-attach, while these buffers only have to cover the moments before a window
 * hydrates / a pane mounts, and the cost is paid once per live session.
 */
export const OUTPUT_TAIL_MAX_BYTES = 500 * 1024

export class OutputTail {
  private readonly max: number
  private chunks: string[] = []
  private total = 0

  constructor(max: number = OUTPUT_TAIL_MAX_BYTES) {
    this.max = max
  }

  /** Retained size in UTF-16 code units; never above `max`. */
  get length(): number {
    return this.total
  }

  append(data: string): void {
    if (data.length === 0) {
      return
    }
    this.chunks.push(data)
    this.total += data.length
    this.trim()
  }

  /** Retained chunks, oldest → newest, and reset to empty. */
  drain(): readonly string[] {
    const out = this.chunks
    this.chunks = []
    this.total = 0
    return out
  }

  /** Retained content as one string, WITHOUT resetting (for tests/inspection). */
  peek(): string {
    return this.chunks.join('')
  }

  /** Drop the oldest units — partially trimming the head chunk — until at/below `max`. */
  private trim(): void {
    while (this.total > this.max && this.chunks.length > 0) {
      const excess = this.total - this.max
      const head = this.chunks[0]
      if (head.length > excess) {
        this.chunks[0] = head.slice(excess)
        this.total = this.max
        return
      }
      this.chunks.shift()
      this.total -= head.length
    }
  }
}
