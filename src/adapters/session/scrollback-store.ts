/**
 * In-memory scrollback store (DESIGN §6.6, §6.2). Realizes the deferred per-session
 * backend ring buffer: every chunk of terminal output is appended here so it can be
 * persisted on quit/exit and replayed into a FRESH terminal on the next launch. The
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
import { RingBuffer } from './ring-buffer'

/** Structural mirror of the application's `ScrollbackBuffers` (see the docblock). */
export interface ScrollbackBuffers {
  append(id: SessionId, data: string): void
  snapshot(id: SessionId): string | undefined
  entries(): Iterable<[SessionId, string]>
  delete(id: SessionId): void
  clear(): void
}

export class RingBufferScrollbackStore implements ScrollbackBuffers {
  /** Optional cap override (mainly for tests); defaults to RingBuffer's ~500 KB. */
  private readonly maxBytes?: number
  private readonly buffers = new Map<SessionId, RingBuffer>()

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
    buf.append(data)
  }

  snapshot(id: SessionId): string | undefined {
    const buf = this.buffers.get(id)
    if (!buf || buf.byteLength === 0) {
      return undefined
    }
    return buf.snapshot()
  }

  *entries(): Iterable<[SessionId, string]> {
    for (const [id, buf] of this.buffers) {
      if (buf.byteLength > 0) {
        yield [id, buf.snapshot()]
      }
    }
  }

  delete(id: SessionId): void {
    this.buffers.delete(id)
  }

  clear(): void {
    this.buffers.clear()
  }
}
