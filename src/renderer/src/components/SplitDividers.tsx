/**
 * Draggable divider gutters over a shown group's split layout (DESIGN §5.7).
 * Rendered by `TaskView` as a single sibling AFTER every `SessionPane`, inside
 * the same `pane-area` — dividers never wrap panes, so dragging one never
 * touches a `SessionPane`'s parent, type, or key (§5.3 keep-alive).
 *
 * This component owns NO backend state and sends no command itself — groups are
 * backend-owned (split-groups design), so a drag only ever reports path/ratio
 * numbers up to `TaskView` via `onPreview` (continuous, for the local preview
 * `TaskView` renders immediately) and `onCommit` (once, on release — the only
 * point a `groups.resize` command is sent). `onCancel` (pointercancel: capture
 * lost mid-drag, e.g. the tab switched away) tells `TaskView` to drop any
 * preview from this gesture without sending anything.
 *
 * One gutter per `splitHandles(tree)` entry, absolutely positioned over its split
 * boundary. `SplitHandle.rect`/`ratio` are in percentages of the pane area, so a
 * drag converts the pointer position to a ratio via THIS overlay's own pixel
 * bounding box (it fills `pane-area` exactly, `inset:0`) — no DOM measurement of
 * individual panes is needed. Pointer capture keeps the drag going even once the
 * cursor leaves the thin hit strip; a trailing `requestAnimationFrame` throttle
 * caps the rate of `onPreview` calls to one per frame. `tree` is the EFFECTIVE
 * tree `TaskView` is currently drawing (its own preview, if one is in flight, or
 * the committed one) so the gutters track the live preview during a drag.
 *
 * A release within `DIVIDER_DRAG_THRESHOLD_PX` of the pointer-down point is treated as a
 * plain click, not a drag — `onCancel`, nothing committed — mirroring
 * `GROUP_DRAG_THRESHOLD_PX` in `SessionTabBar.tsx`'s group-line drag.
 *
 * Stuck-drag defense: in Electron 33, removing (and possibly reinserting) the element
 * that holds pointer capture drops capture SILENTLY — no `lostpointercapture` fires — so
 * the subsequent native `pointerup`/`pointercancel` goes to whatever is under the pointer
 * and bubbles to `window`, never reaching the (now-detached) gutter. The one case that
 * detaches a gutter mid-drag is `TaskView` keying the WHOLE `SplitDividers` instance by
 * group id (see its own comment) when the mark moves to a different group — a full
 * unmount, not a per-gutter recreation: within one instance, gutters are keyed by `path`
 * (`handles.map` below), so a `tree` update that keeps the same paths reuses the same DOM
 * nodes (capture intact) — only a path that VANISHES from the new `handles` list detaches
 * its node. To cover the silent-drop case, `pointerup`/`pointercancel` are listened for
 * both on the capturing gutter element AND on `window` (via
 * `target.ownerDocument.defaultView`), the latter filtered by `pointerId`; both route
 * through the same end/commit/cancel logic, and `endDrag` guards on a local `ended` flag
 * so the normal case — where the SAME bubbled event reaches both the element and the
 * window listener — only tears down once. `lostpointercapture` is still listened for too,
 * for an explicit release that doesn't involve removing the element.
 */

import { useCallback, useEffect, useRef } from 'react'
import { splitHandles, type SplitHandle, type SplitPath } from '../store/split-layout'
import type { SplitNode } from '../../../shared/dto'
import { color } from '../style/tokens'

export interface SplitDividersProps {
  readonly tree: SplitNode
  /** Continuous report while the pointer moves (rAF-throttled) — render-only, no command. */
  readonly onPreview: (path: SplitPath, ratio: number) => void
  /** Once, on release — the only point a `groups.resize` command is sent. */
  readonly onCommit: (path: SplitPath, ratio: number) => void
  /** The gesture ended without a release (capture lost) — drop the preview, send nothing. */
  readonly onCancel: () => void
}

/** Pixel width/height of the draggable hit strip, centered on the split boundary. */
const GUTTER_HIT_PX = 6

/** Pixels of pointer movement (down → up) required for a release to commit a resize
 * instead of being treated as a plain click (mirrors `GROUP_DRAG_THRESHOLD_PX` in
 * `SessionTabBar.tsx`). */
const DIVIDER_DRAG_THRESHOLD_PX = 4

export function SplitDividers({
  tree,
  onPreview,
  onCommit,
  onCancel: onGestureCancel
}: SplitDividersProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  // Tears down an in-flight drag; run on unmount (e.g. the split collapses mid-drag).
  const endDragRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => endDragRef.current?.(), [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, handle: SplitHandle) => {
      // Not a drag handle for anything else (no selection, no xterm underneath it —
      // it sits over the gap between panes) — safe to fully own the gesture.
      e.preventDefault()
      e.stopPropagation()
      const overlay = overlayRef.current
      if (!overlay) return
      const overlayRect = overlay.getBoundingClientRect()
      const target = e.currentTarget
      const win = target.ownerDocument.defaultView
      const pointerId = e.pointerId
      const startX = e.clientX
      const startY = e.clientY
      target.setPointerCapture(pointerId)
      const { rect, dir, path } = handle

      let rafId: number | undefined
      const ratioAt = (clientX: number, clientY: number): number => {
        if (dir === 'row') {
          const left = overlayRect.left + (rect.left / 100) * overlayRect.width
          const width = (rect.width / 100) * overlayRect.width
          return width > 0 ? (clientX - left) / width : 0.5
        }
        const top = overlayRect.top + (rect.top / 100) * overlayRect.height
        const height = (rect.height / 100) * overlayRect.height
        return height > 0 ? (clientY - top) / height : 0.5
      }
      const onMove = (ev: PointerEvent): void => {
        if (rafId !== undefined) cancelAnimationFrame(rafId)
        rafId = requestAnimationFrame(() => {
          rafId = undefined
          onPreview(path, ratioAt(ev.clientX, ev.clientY))
        })
      }
      // Guards against the SAME native event reaching both the element-level listener
      // and the window-level listener below (the normal case: capture intact, the event
      // dispatches at `target` and bubbles up through `window` too) — only the first to
      // arrive tears down and acts; the second is a no-op.
      let ended = false
      const endDrag = (): boolean => {
        if (ended) return false
        ended = true
        endDragRef.current = undefined
        if (rafId !== undefined) cancelAnimationFrame(rafId)
        rafId = undefined
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onPointerCancel)
        target.removeEventListener('lostpointercapture', onLostCapture)
        win?.removeEventListener('pointerup', onWindowUp)
        win?.removeEventListener('pointercancel', onWindowCancel)
        // Listeners first: release throws if the capture is already gone.
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
        return true
      }
      // A pending frame would drop the last move, so commit the release point directly —
      // this is the ONE `groups.resize` the whole gesture sends. Below the movement
      // threshold, treat the release as a plain click instead: drop the preview, send
      // nothing (a click with no drag must not silently commit whatever ratio the hit
      // strip's own position happens to be at).
      const onUp = (ev: PointerEvent): void => {
        if (!endDrag()) return
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (Math.hypot(dx, dy) < DIVIDER_DRAG_THRESHOLD_PX) {
          onGestureCancel()
          return
        }
        onCommit(path, ratioAt(ev.clientX, ev.clientY))
      }
      // Capture lost without a release (e.g. the tab switched away mid-drag, or — see
      // the class comment — the whole component was remounted out from under the
      // gesture): drop the preview, send nothing — there is no "last known good ratio"
      // to commit to.
      const onPointerCancel = (): void => {
        if (!endDrag()) return
        onGestureCancel()
      }
      const onLostCapture = (): void => {
        if (!endDrag()) return
        onGestureCancel()
      }
      // Window-level fallback for the silent-capture-drop case (class comment): filtered
      // by `pointerId` since `window` sees pointer events for the whole app, not just
      // this gesture.
      const onWindowUp = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) onUp(ev)
      }
      const onWindowCancel = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) onPointerCancel()
      }
      endDragRef.current?.()
      endDragRef.current = () => endDrag()
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onPointerCancel)
      target.addEventListener('lostpointercapture', onLostCapture)
      win?.addEventListener('pointerup', onWindowUp)
      win?.addEventListener('pointercancel', onWindowCancel)
    },
    [onPreview, onCommit, onGestureCancel]
  )

  const handles = splitHandles(tree)

  return (
    <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {handles.map((h) => {
        const key = h.path.join('') || 'root'
        const vertical = h.dir === 'row' // 'row' children sit side by side → a vertical bar.
        const boundaryPct = vertical
          ? h.rect.left + h.rect.width * h.ratio
          : h.rect.top + h.rect.height * h.ratio
        const gutterStyle: React.CSSProperties = vertical
          ? {
              position: 'absolute',
              left: `calc(${boundaryPct}% - ${GUTTER_HIT_PX / 2}px)`,
              top: `${h.rect.top}%`,
              width: GUTTER_HIT_PX,
              height: `${h.rect.height}%`,
              cursor: 'col-resize',
              pointerEvents: 'auto'
            }
          : {
              position: 'absolute',
              top: `calc(${boundaryPct}% - ${GUTTER_HIT_PX / 2}px)`,
              left: `${h.rect.left}%`,
              width: `${h.rect.width}%`,
              height: GUTTER_HIT_PX,
              cursor: 'row-resize',
              pointerEvents: 'auto'
            }
        const lineStyle: React.CSSProperties = vertical
          ? {
              position: 'absolute',
              left: '50%',
              top: 0,
              bottom: 0,
              width: 1,
              marginLeft: -0.5,
              background: color.border
            }
          : {
              position: 'absolute',
              top: '50%',
              left: 0,
              right: 0,
              height: 1,
              marginTop: -0.5,
              background: color.border
            }
        return (
          <div key={key} style={gutterStyle} onPointerDown={(e) => onPointerDown(e, h)}>
            <div style={lineStyle} />
          </div>
        )
      })}
    </div>
  )
}
