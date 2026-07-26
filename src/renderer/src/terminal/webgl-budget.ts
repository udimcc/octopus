/**
 * A module-level lease pool that bounds concurrent WebGL renderer contexts
 * (DESIGN §5.3). Keep-alive keeps every session pane mounted at once, but browsers
 * cap live WebGL contexts (~16 in Chromium); the 16th+ terminal would either fail
 * to acquire a context or evict an older one, dropping its accelerated rendering
 * unpredictably. So a pane must LEASE a WebGL slot before using `WebglAddon`; if
 * none is free it renders with `CanvasAddon` instead — still hardware-accelerated
 * (2D canvas), perfectly adequate for a hidden/background buffering pane, and it
 * consumes no WebGL context.
 *
 * The policy is "active panes get WebGL": a pane requests a lease when it becomes
 * visible and releases it when hidden, so the (few) visible terminals get the
 * fastest renderer and the many hidden ones fall back to Canvas. Requests are
 * granted FIFO up to `maxLeases`.
 *
 * This is renderer-local bookkeeping, not a real GL resource — the lease is just a
 * counter/permit. `TerminalPane` maps a held lease → load `WebglAddon`, a denied
 * one → load `CanvasAddon`, and still keeps xterm's built-in DOM renderer as the
 * last-resort fallback if even Canvas construction throws.
 */

/** Browsers allow ~16 live WebGL contexts; leave headroom for the rest of the app. */
export const DEFAULT_MAX_LEASES = 15

export class WebglBudget {
  private readonly held = new Set<string>()

  constructor(private readonly maxLeases: number = DEFAULT_MAX_LEASES) {}

  /**
   * Try to acquire a WebGL lease for `key` (a session id). Returns `true` if the
   * caller may use WebGL, `false` if it should fall back to Canvas. Idempotent: a
   * key that already holds a lease keeps it and still returns `true`.
   */
  acquire(key: string): boolean {
    if (this.held.has(key)) return true
    if (this.held.size >= this.maxLeases) return false
    this.held.add(key)
    return true
  }

  /** Release `key`'s lease (on hide/unmount). Idempotent. */
  release(key: string): void {
    this.held.delete(key)
  }

  /** Whether `key` currently holds a lease. */
  has(key: string): boolean {
    return this.held.has(key)
  }

  /** Count of outstanding leases (for tests/diagnostics). */
  get size(): number {
    return this.held.size
  }
}

/** The single app-wide budget shared by every `TerminalPane`. */
export const webglBudget = new WebglBudget()
