/**
 * Pure window-bounds helpers (DESIGN §6.3, §6.7). Kept free of Electron so they
 * are unit-testable under host Node — the effectful callers in `window.ts`/
 * `index.ts` pass in the display work-areas they read from `screen`.
 *
 * A window record persisted on one monitor layout may be off-screen on the next
 * launch (monitor unplugged, resolution changed). `clampToDisplays` snaps such a
 * window back onto the nearest display, preserving its size where it fits.
 */

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Whether two rects overlap by at least `minVisible` px in BOTH dimensions. */
function intersectsEnough(a: Rect, b: Rect, minVisible: number): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return overlapX >= minVisible && overlapY >= minVisible
}

/** Squared distance between the centers of two rects (avoids a sqrt). */
function centerDistanceSq(a: Rect, b: Rect): number {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2)
  const dy = a.y + a.height / 2 - (b.y + b.height / 2)
  return dx * dx + dy * dy
}

/**
 * If `bounds` is visible on some display, return it unchanged. Otherwise clamp it
 * onto the display whose center is nearest, preserving width/height (shrinking only
 * if larger than that display's work area) and snapping the top-left inside.
 *
 * `displays` are the work-areas (`Display.workArea`) of the connected monitors.
 * With no displays (shouldn't happen once the app is ready), the bounds pass
 * through unchanged.
 */
export function clampToDisplays(bounds: Rect, displays: readonly Rect[], minVisible = 64): Rect {
  if (displays.length === 0) {
    return bounds
  }
  if (displays.some((d) => intersectsEnough(bounds, d, minVisible))) {
    return bounds
  }

  // Off every screen: pick the nearest display and place the window inside it.
  let nearest = displays[0]
  let best = centerDistanceSq(bounds, nearest)
  for (const d of displays.slice(1)) {
    const dist = centerDistanceSq(bounds, d)
    if (dist < best) {
      best = dist
      nearest = d
    }
  }

  const width = Math.min(bounds.width, nearest.width)
  const height = Math.min(bounds.height, nearest.height)
  const x = Math.max(nearest.x, Math.min(bounds.x, nearest.x + nearest.width - width))
  const y = Math.max(nearest.y, Math.min(bounds.y, nearest.y + nearest.height - height))
  return { x, y, width, height }
}
