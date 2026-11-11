/**
 * In-memory scrollback store (DESIGN §6.6, §6.2). Realizes the deferred per-session
 * backend ring buffer: every chunk of terminal output is appended here so it can be
 * persisted (periodically, on quit and on exit) and replayed into a FRESH terminal on the next launch. The
 * byte cap and eviction come straight from {@link RingBuffer} (the tested §6.6/§6.2
 * building block), one instance per session.
 *
 * This is the concrete side of the application's `ScrollbackBuffers` port. Like
 * `socket-provisioner.ts`, the interface is re-declared locally (structurally
 * identical to the application's) rather than imported — the boundary rule forbids
 * an adapter from importing `application`; the composition root, which may import
 * both, assigns this instance to the application-typed field.
 *
 * Captured output is metadata, not live process state (I13): on restore a new PTY
 * is still spawned; the history is only prepended for the user to read.
 */

import type { SessionId } from '../../domain/ids'
import { RingBuffer } from '../../shared/node/ring-buffer'
import { historySizeMarker } from '../../shared/restored-history'

/**
 * Output between repeats of the current size marker. The ring evicts its oldest
 * chunks, the first marker with them, so the marker is repeated: at most this much
 * at the top of a long history replays without its recorded size.
 */
export const SIZE_MARKER_INTERVAL = 64 * 1024

/** Structural mirror of the application's `ScrollbackBuffers` (see the docblock). */
export interface ScrollbackBuffers {
  append(id: SessionId, data: string): void
  setSize(id: SessionId, cols: number, rows: number): void
  snapshot(id: SessionId): string | undefined
  dirtyEntries(): Iterable<[SessionId, string]>
  markClean(id: SessionId): void
  delete(id: SessionId): void
  clear(): void
}

export class RingBufferScrollbackStore implements ScrollbackBuffers {
  /** Optional cap override (mainly for tests); defaults to RingBuffer's ~500 KB. */
  private readonly maxBytes?: number
  private readonly buffers = new Map<SessionId, RingBuffer>()
  /** Sessions appended to since their last flush, in insertion (= longest-dirty) order. */
  private readonly dirty = new Set<SessionId>()
  /** Per session: the current size marker and the output appended since it was written. */
  private readonly sizes = new Map<SessionId, { marker: string; since: number }>()

  constructor(maxBytes?: number) {
    this.maxBytes = maxBytes
  }

  append(id: SessionId, data: string): void {
    if (data.length === 0) {
      return
    }
    let buf = this.buffers.get(id)
    if (!buf) {
      buf = new RingBuffer(this.maxBytes)
      this.buffers.set(id, buf)
    }
    // The size marker rides in the same chunk as the output it describes, so the ring
    // never keeps one without the other.
    const size = this.sizes.get(id)
    if (size && size.since >= SIZE_MARKER_INTERVAL) {
      data = size.marker + data
      size.since = 0
    }
    if (size) size.since += data.length
    buf.append(data)
    this.dirty.add(id)
  }

  /** Recorded ahead of the next output; nothing is written until output arrives. */
  setSize(id: SessionId, cols: number, rows: number): void {
    const marker = historySizeMarker(cols, rows)
    if (this.sizes.get(id)?.marker !== marker) {
      this.sizes.set(id, { marker, since: Infinity })
    }
  }

  snapshot(id: SessionId): string | undefined {
    const buf = this.buffers.get(id)
    if (!buf || buf.byteLength === 0) {
      return undefined
    }
    return buf.snapshot()
  }

  *dirtyEntries(): Iterable<[SessionId, string]> {
    // Copy the id list first: the caller marks entries clean while iterating.
    for (const id of [...this.dirty]) {
      const buf = this.buffers.get(id)
      if (buf && buf.byteLength > 0) {
        yield [id, buf.snapshot()]
      } else {
        this.dirty.delete(id)
      }
    }
  }

  markClean(id: SessionId): void {
    this.dirty.delete(id)
  }

  delete(id: SessionId): void {
    this.buffers.delete(id)
    this.dirty.delete(id)
    this.sizes.delete(id)
  }

  clear(): void {
    this.buffers.clear()
    this.dirty.clear()
    this.sizes.clear()
  }
}
