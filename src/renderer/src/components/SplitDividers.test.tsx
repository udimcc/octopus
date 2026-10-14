/**
 * `<SplitDividers>` drag wiring (DESIGN §5.7, split-groups design): one gutter per
 * `splitHandles(tree)` entry; a drag converts pointer position to a ratio via the
 * overlay's own pixel box and calls `onPreview` (continuous, rAF-throttled);
 * release calls `onCommit` ONCE with the final ratio, even with a frame still
 * pending; a release within the click threshold calls `onCancel` instead
 * (nothing committed); an unmount mid-drag tears the gesture down so no further
 * callback can fire.
 *
 * This component owns no backend state and sends no command itself (split-groups
 * design: groups are backend-owned) — `onPreview`/`onCommit`/`onCancel` are plain
 * `vi.fn()` spies here, asserting exactly what `SplitDividers` computed from the
 * pointer position, independent of `TaskView`'s own preview/commit wiring (covered
 * by `TaskView.test.tsx`) or the store.
 *
 * jsdom has no pointer-capture or layout implementation, so both are stubbed:
 * `setPointerCapture`/`hasPointerCapture`/`releasePointerCapture` are no-ops, and
 * `getBoundingClientRect` returns a fixed 1000×1000 box for every element — only
 * the overlay's own box is read by the component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { SplitDividers } from './SplitDividers'
import type { SplitNode } from '../../../shared/dto'

const RECT = { left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000, x: 0, y: 0 }

function leaf(sessionId: string): SplitNode {
  return { kind: 'leaf', sessionId }
}

function split(a: SplitNode, dir: 'row' | 'col', b: SplitNode, ratio = 0.5): SplitNode {
  return { kind: 'split', dir, ratio, a, b }
}

/**
 * This jsdom has no `PointerEvent` constructor at all (`fireEvent.pointerDown` etc.
 * silently fall back to a plain `Event` with no `clientX`/`clientY`/`pointerId`), so
 * pointer gestures are built from a `MouseEvent` (which DOES carry `clientX`/`clientY`
 * in this jsdom) with `pointerId` attached. `SplitDividers` only reads these fields
 * structurally — it never checks `instanceof PointerEvent` — so this is a faithful
 * stand-in for the real gesture.
 */
function firePointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  target: Element,
  props: { pointerId: number; clientX: number; clientY: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: props.clientX,
    clientY: props.clientY
  })
  Object.defineProperty(event, 'pointerId', { value: props.pointerId })
  fireEvent(target, event)
}

describe('<SplitDividers> drag wiring (§5.7)', () => {
  let onPreview: ReturnType<typeof vi.fn>
  let onCommit: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>

  // Captured so the stubs below can be restored exactly (not just deleted), rather
  // than leaking a permanently-stubbed `HTMLElement.prototype` into whichever other
  // test file's process/worker runs next.
  let originalSetPointerCapture: PropertyDescriptor | undefined
  let originalHasPointerCapture: PropertyDescriptor | undefined
  let originalReleasePointerCapture: PropertyDescriptor | undefined
  let originalGetBoundingClientRect: PropertyDescriptor | undefined

  beforeEach(() => {
    cleanup()
    onPreview = vi.fn()
    onCommit = vi.fn()
    onCancel = vi.fn()

    originalSetPointerCapture = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'setPointerCapture'
    )
    originalHasPointerCapture = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'hasPointerCapture'
    )
    originalReleasePointerCapture = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'releasePointerCapture'
    )
    originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'getBoundingClientRect'
    )

    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn()
    })
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: vi.fn(() => true)
    })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn()
    })
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => RECT
    })
  })

  afterEach(() => {
    const restore = (prop: string, original: PropertyDescriptor | undefined): void => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, prop, original)
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
      }
    }
    restore('setPointerCapture', originalSetPointerCapture)
    restore('hasPointerCapture', originalHasPointerCapture)
    restore('releasePointerCapture', originalReleasePointerCapture)
    restore('getBoundingClientRect', originalGetBoundingClientRect)
  })

  function renderDividers(tree: SplitNode): ReturnType<typeof render> {
    return render(
      <SplitDividers tree={tree} onPreview={onPreview} onCommit={onCommit} onCancel={onCancel} />
    )
  }

  it('renders one gutter per split node', () => {
    // Two split nodes: root is a COL split of (row(s1, s2)) and s3; the inner node
    // (s1|s2) is the ROW split.
    const tree: SplitNode = split(split(leaf('s1'), 'row', leaf('s2')), 'col', leaf('s3'))
    const { container } = renderDividers(tree)
    const overlay = container.firstElementChild as HTMLElement
    expect(overlay.children).toHaveLength(2)
  })

  it('pointerdown + move (throttled to a rAF) + up calls onPreview then onCommit with the computed ratio', async () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    expect(onPreview).not.toHaveBeenCalled()

    // A move schedules a rAF rather than calling synchronously.
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    expect(onPreview).not.toHaveBeenCalled()
    await new Promise((r) => requestAnimationFrame(r))
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenLastCalledWith([], 0.7)

    // A burst of moves within one frame collapses to a single call.
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 710, clientY: 500 })
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 720, clientY: 500 })
    await new Promise((r) => requestAnimationFrame(r))
    expect(onPreview).toHaveBeenCalledTimes(2)
    expect(onPreview).toHaveBeenLastCalledWith([], 0.72)

    // Moved well past the click threshold, so release commits.
    firePointer('pointerup', gutter, { pointerId: 1, clientX: 800, clientY: 500 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith([], 0.8)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('onCommit applies the final release position even with a rAF still pending, and the stale frame never fires onPreview again', async () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    // Schedule a frame for 0.7, then release at 0.8 BEFORE that frame runs.
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    firePointer('pointerup', gutter, { pointerId: 1, clientX: 800, clientY: 500 })

    // The release committed its own ratio directly — no frame needed yet.
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith([], 0.8)

    // If the pending frame from the move had NOT been cancelled, it would fire
    // here and call onPreview with the stale 0.7.
    await new Promise((r) => requestAnimationFrame(r))
    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a release within the click threshold calls onCancel only — nothing committed', () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    // 2px of movement — below DIVIDER_DRAG_THRESHOLD_PX (4).
    firePointer('pointerup', gutter, { pointerId: 1, clientX: 502, clientY: 500 })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onPreview).not.toHaveBeenCalled()
  })

  it('a window-level pointerup (silent capture drop) ends the drag exactly like the element-level one', () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    // Fired on window, not the (possibly-detached) gutter.
    firePointer('pointerup', window as unknown as Element, {
      pointerId: 1,
      clientX: 800,
      clientY: 500
    })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith([], 0.8)

    // A SEPARATE, later dispatch directly on the (still-attached) gutter element must
    // be a no-op — the drag already ended via the window-level dispatch above, so the
    // `ended` guard must suppress this second, independent `pointerup` too.
    firePointer('pointerup', gutter, { pointerId: 1, clientX: 800, clientY: 500 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a pointercancel on the gutter ends the drag with onCancel, never onCommit', () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    firePointer('pointercancel', gutter, { pointerId: 1, clientX: 700, clientY: 500 })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a lostpointercapture on the gutter ends the drag with onCancel, never onCommit', () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    firePointer('lostpointercapture', gutter, { pointerId: 1, clientX: 700, clientY: 500 })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a window-level pointercancel (silent capture drop) ends the drag with onCancel, never onCommit', () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    // Fired on window, not the (possibly-detached) gutter.
    firePointer('pointercancel', window as unknown as Element, {
      pointerId: 1,
      clientX: 700,
      clientY: 500
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()

    // A later window pointerup for the same gesture must be a no-op (the `ended` guard
    // must hold across the cancel path too, not just the up-then-up path).
    firePointer('pointerup', window as unknown as Element, {
      pointerId: 1,
      clientX: 800,
      clientY: 500
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a mid-drag window pointerup with a DIFFERENT pointerId is ignored', () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    // A different pointer's window-level pointerup (e.g. another finger/pen/mouse
    // button) must not end THIS drag.
    firePointer('pointerup', window as unknown as Element, {
      pointerId: 2,
      clientX: 800,
      clientY: 500
    })
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()

    // The real drag is still live and ends normally afterward.
    firePointer('pointerup', gutter, { pointerId: 1, clientX: 800, clientY: 500 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith([], 0.8)
  })

  it('unmounting mid-drag tears down the gesture: no further onPreview/onCommit calls', async () => {
    const tree: SplitNode = split(leaf('s1'), 'row', leaf('s2'))
    const { container, unmount } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 500, clientY: 500 })
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 700, clientY: 500 })
    await new Promise((r) => requestAnimationFrame(r))
    expect(onPreview).toHaveBeenCalledTimes(1)

    unmount()

    // The listeners were attached directly to this (still-referenced) DOM node;
    // dispatching further events on it must now be inert.
    firePointer('pointermove', gutter, { pointerId: 1, clientX: 900, clientY: 500 })
    await new Promise((r) => requestAnimationFrame(r))
    firePointer('pointerup', gutter, { pointerId: 1, clientX: 900, clientY: 500 })
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('a drag on an INNER (non-root) gutter computes the ratio within its own sub-rect and passes its path', () => {
    // root row(s1 | row(s2 | s3)): a SAME-direction nested split, so the inner
    // handle's own SplitHandle.rect is {left:50,top:0,width:50,height:100} (per
    // `splitHandles`/`toRects`) — both offset in `left` AND shrunk in `width`
    // relative to the root's full {left:0,width:100} box. In overlay pixels (0..1000
    // for the 0..100% box) that rect is left=500px, width=500px, so its boundary
    // (left + ratio*width) sits at 75% = 750px. Firing the drag at clientX=750
    // catches two separate mutants: reusing the ROOT's rect instead of the inner
    // handle's own (left=0/width=1000 -> ratio (750-0)/1000 = 0.75, not 0.5), and
    // reading the rect's `width` but dropping its `left` offset (ratio
    // (750-0)/500 = 1.5, not 0.5).
    const tree: SplitNode = split(leaf('s1'), 'row', split(leaf('s2'), 'row', leaf('s3')))
    const { container } = renderDividers(tree)
    const overlay = container.firstElementChild as HTMLElement
    const innerGutter = overlay.children[1] as HTMLElement // path ['b']; root is children[0]

    // Down away from the release point so the move clears DIVIDER_DRAG_THRESHOLD_PX —
    // otherwise the release is treated as a click (onCancel), not a commit.
    firePointer('pointerdown', innerGutter, { pointerId: 1, clientX: 740, clientY: 0 })
    firePointer('pointerup', innerGutter, { pointerId: 1, clientX: 750, clientY: 0 })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith(['b'], 0.5)
  })

  it('a COLUMN split (dir "col") computes its ratio from clientY, not clientX', () => {
    const tree: SplitNode = split(leaf('s1'), 'col', leaf('s2'))
    const { container } = renderDividers(tree)
    const gutter = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement

    firePointer('pointerdown', gutter, { pointerId: 1, clientX: 999, clientY: 0 })
    // Root rect spans the full 1000px overlay on both axes, so ratio = clientY / 1000
    // regardless of clientX — 300 -> 0.3.
    firePointer('pointerup', gutter, { pointerId: 1, clientX: 1, clientY: 300 })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith([], 0.3)
  })
})
