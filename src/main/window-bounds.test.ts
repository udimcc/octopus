import { describe, it, expect } from 'vitest'
import { clampToDisplays, type Rect } from './window-bounds'

/** A single 1920×1080 display at the origin (work area). */
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
/** A second display to the right (a common dual-monitor layout). */
const RIGHT: Rect = { x: 1920, y: 0, width: 1920, height: 1080 }

describe('clampToDisplays (§6.3, §6.7)', () => {
  it('returns fully-visible bounds unchanged', () => {
    const bounds: Rect = { x: 100, y: 100, width: 900, height: 640 }
    expect(clampToDisplays(bounds, [PRIMARY])).toBe(bounds)
  })

  it('keeps a window straddling two displays unchanged (visible on both)', () => {
    const bounds: Rect = { x: 1800, y: 100, width: 400, height: 640 }
    expect(clampToDisplays(bounds, [PRIMARY, RIGHT])).toBe(bounds)
  })

  it('snaps an off-screen (unplugged-monitor) window back onto the nearest display, preserving size', () => {
    // Persisted on a now-absent right monitor; only PRIMARY remains.
    const bounds: Rect = { x: 3000, y: 200, width: 900, height: 640 }
    const clamped = clampToDisplays(bounds, [PRIMARY])
    expect(clamped.width).toBe(900)
    expect(clamped.height).toBe(640)
    // Top-left snapped inside the primary work area.
    expect(clamped.x).toBe(PRIMARY.x + PRIMARY.width - 900)
    expect(clamped.y).toBe(200)
    // And it is now visible on the primary display.
    expect(clampToDisplays(clamped, [PRIMARY])).toEqual(clamped)
  })

  it('leaves a window that still overlaps by ≥ the min-visible margin unchanged', () => {
    // Off the top-left but still showing 300×200 px of itself → above the 64 px
    // threshold, so it counts as visible and is not moved.
    const bounds: Rect = { x: -500, y: -400, width: 800, height: 600 }
    expect(clampToDisplays(bounds, [PRIMARY])).toBe(bounds)
  })

  it('snaps a window dragged almost entirely off the top-left back to the display origin', () => {
    // Only 20×20 px remain on screen (below the 64 px min-visible) → clamped inside.
    const bounds: Rect = { x: -780, y: -580, width: 800, height: 600 }
    const clamped = clampToDisplays(bounds, [PRIMARY])
    expect(clamped).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('shrinks a window larger than the target display to fit', () => {
    const small: Rect = { x: 0, y: 0, width: 1280, height: 800 }
    const bounds: Rect = { x: 5000, y: 5000, width: 2000, height: 1200 }
    const clamped = clampToDisplays(bounds, [small])
    expect(clamped.width).toBe(1280)
    expect(clamped.height).toBe(800)
    expect(clamped.x).toBe(0)
    expect(clamped.y).toBe(0)
  })

  it('picks the nearest display when several are connected', () => {
    // Off-screen to the far right → nearest is the RIGHT display, not PRIMARY.
    const bounds: Rect = { x: 5000, y: 100, width: 400, height: 300 }
    const clamped = clampToDisplays(bounds, [PRIMARY, RIGHT])
    expect(clamped.x).toBeGreaterThanOrEqual(RIGHT.x)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(RIGHT.x + RIGHT.width)
  })

  it('passes bounds through unchanged when no displays are reported', () => {
    const bounds: Rect = { x: 9999, y: 9999, width: 100, height: 100 }
    expect(clampToDisplays(bounds, [])).toBe(bounds)
  })
})
