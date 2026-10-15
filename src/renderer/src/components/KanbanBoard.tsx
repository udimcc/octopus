/**
 * The Issues drawer's Board tab (PRD "Issues" → "Board"; DESIGN
 * `docs/plans/kanban-board_2026-10-14-design.md` → "Board" and "Drag-and-drop"). Four
 * always-expanded status columns built from the same `groupIssuesByStatus` as
 * `IssueList`'s groups, so counts and order match the List tab exactly. Self-contained
 * in the same way `IssueList` is: reads `issues`/`tasks`/`selectedIssueId`/`issueDraft`
 * from the store directly and dispatches `selectIssue` itself.
 *
 * Each column carries `data-issue-status` (its `IssueStatusDTO`) as the drop-target
 * hook, and its body list fills the column's full height even when empty ("No issues")
 * so the whole area is droppable, not just visible cards.
 *
 * ## Drag-and-drop (DESIGN "Drag-and-drop")
 *
 * All drag state lives HERE, not in `KanbanCard` (kept a plain prop sink, like
 * `onSelect`): `dragIssueId` (the id mid-drag, for dimming the original card and
 * suppressing its next click) and `dragOverStatus` (the column currently under the
 * pointer, for its highlight) are the only two bits that cause a re-render; everything
 * else — the ghost's position every pointermove — is pushed straight onto the ghost's
 * DOM node via `ghostRef`, never through React, so dragging stays cheap even over many
 * cards (per the design's VDI-smoothness note).
 *
 * Pointer handling (`startCardDrag`) is the manual pointer-capture-plus-window-fallback
 * pattern copied from `SplitDividers.tsx`'s gutter drag and `SessionTabBar.tsx`'s
 * `startGroupDrag` (same `CARD_DRAG_THRESHOLD_PX` idea as their `*_DRAG_THRESHOLD_PX`):
 * capture starts tracking immediately on a primary-button pointerdown, but a drag only
 * "starts" (ghost shown, original dimmed) once the pointer has moved past the
 * threshold — a release before that is a plain click. Electron 33 drops pointer capture
 * silently with no `lostpointercapture` when the capturing element is removed/recreated
 * mid-drag, so `pointerup`/`pointercancel` are also listened for on `window` (filtered
 * by `pointerId`), both routing through the same `endDrag`, guarded by a local `ended`
 * flag so the normal case (the same event reaching both listeners) only tears down once.
 *
 * A completed drag must not also select the card: `justDraggedRef` is set `true` in the
 * `pointerup` handler the instant a real drag is detected, synchronously before the
 * browser's own `click` (which always lands on the SAME button here, since pointer
 * capture redirects the mouse-compat events too) fires; `KanbanCard`'s `onSelect`
 * wrapper below checks and consumes that flag instead of calling `selectIssue`, clearing
 * it on a macrotask (`setTimeout(0)`) rather than synchronously, so it only ever
 * swallows the ONE click synthesized by that same pointerup. A below-threshold release
 * never sets it, so a plain click selects as always, and dragging itself never touches
 * `selectIssue`. `startCardDrag` resets the flag to `false` at its very start (a card
 * that remounts mid-drag — e.g. a linked task's create flow moves it to another
 * column — must not leave a stale `true` from a previous gesture around to eat the
 * user's next real click) and tears down any previous in-flight gesture first
 * (`dragCancelRef.current?.()`), since a new pointerdown with no matching pointerup
 * would otherwise leak the old one's listeners.
 *
 * The ghost is a second `KanbanCard` instance (its `ghost` prop, so it renders a
 * non-interactive `aria-hidden` `<div>` rather than a `<button>`), undimmed and
 * `pointerEvents: 'none'`, portaled to `document.body` — the drawer slides in via a CSS
 * `transform` (`.claude/rules/modals-and-overlays.md`), which would otherwise confine a
 * `position: fixed` ghost to the drawer's own bounds. It is positioned with `left: 0;
 * top: 0` set ONCE and moved purely by `transform: translate(...)` afterwards (no
 * per-move `top`/`left`), and is not a dialog (no `role="dialog"`/`aria-modal`), so it
 * never affects `topmostModal()`. No shadow, blur, filter, transition or animation.
 *
 * The column under the pointer is found by `elementFromPoint` → `closest`
 * (`[data-issue-status]`), which matches anywhere in a column (header, empty space, or
 * a card) since every card sits inside its column's `<section>`; it's computed once per
 * `pointermove`/`pointerup` OUTSIDE any state updater (`findColumnStatus`), and
 * `setDragOverStatus` is only called when the result actually differs from a plain
 * local variable scoped to the gesture's own closure (the `dragOverStatus` state value
 * itself would be stale inside these listeners — they're created once per gesture, not
 * per render). Dropping on a
 * **different** column reads the issue's CURRENT status from the store
 * (`useStore.getState().issues[id]?.status`, not the `status` closed over at drag
 * start, which could be stale if something else changed it mid-drag) and, if it still
 * differs from the drop target, calls the exact same `issues.update({ issueId, status
 * })` IPC as the toolbar status dropdown (`IssueDetail`); a failure (`ack.ok === false`
 * or a rejected promise, cleaned via `cleanIpcError`) surfaces through the same
 * `pushToast('error', …)` used for other drag/reorder failures elsewhere
 * (`SessionTabBar`). Dropping on the same column, or outside every column, is a no-op;
 * the card's new position (on an actual status change) comes from the normal
 * `issueUpserted` store projection, not an optimistic local move.
 *
 * Esc cancels only an in-progress drag: a `window` `keydown` listener in the CAPTURE
 * phase, added imperatively the instant the drag threshold is crossed (not via a
 * React-state-driven effect, which would lag a render behind) and removed inside
 * `endDrag`, calls `stopImmediatePropagation` + `preventDefault` on Escape before it can
 * reach `IssuesDrawer`'s own Escape handling (a React-level bubble listener) or the
 * window-level `useKeyboardShortcuts` fallback — both map Escape to closing the drawer.
 * Cancelling this way (rather than a real drop) still ends with the pointer down and
 * captured: releasing it afterwards over the original card would otherwise fire a
 * `click` that selects it, so the Esc handler also arms a one-shot window `pointerup`
 * (capture phase) that sets `justDraggedRef` — cleared the same macrotask-later way —
 * removed on the next pointerup or on unmount, whichever comes first. A drag is also
 * cancelled if the drawer closes out from under it (`issuesDrawerOpen` watched directly
 * — this component itself only unmounts on a tab switch, not on close, since the drawer
 * stays mounted and merely slides offscreen), if the dragged issue disappears (deleted
 * elsewhere), or if this component unmounts; all these routes funnel through the same
 * `dragCancelRef`, which tears down the listeners/capture and clears the visual state
 * without sending any command. No keyboard drag — the toolbar status dropdown remains
 * the keyboard path.
 *
 * VDI constraint: no box-shadow, blur, filter, transition or animation anywhere in this
 * component or `KanbanCard` (see its own doc comment for the selected-highlight
 * approach).
 *
 * ## Selection follow (DESIGN §13.5)
 *
 * Whenever `selectedIssueId` changes — including on mount, e.g. right after switching
 * from the List tab, or the task-row icon (`TaskListItem`) opening straight onto this
 * tab with an issue already selected — `useFollowSelectedIssue` (shared with
 * `IssueList`) scrolls that card into view within its column (and horizontally across
 * columns, via the same `scrollIntoView` call) with `block: 'nearest'`/
 * `inline: 'nearest'`: a no-op when the card is already visible, so a plain click on an
 * on-screen card never causes an unwanted jump. The lookup is scoped to `boardRef`'s
 * subtree (not `document`), so it can never match the drag ghost's own `data-issue-id`
 * copy (portaled to `document.body`, outside that subtree). Guarded on
 * `issuesDrawerOpen`: while the drawer is closed it is merely translated off-screen via
 * CSS `transform` — still mounted (DESIGN §13.5) — so there's nothing worth scrolling
 * into view yet; deferred until the drawer is actually open, which the hook re-runs for
 * since `isOpen` is one of its own triggers.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/store'
import { groupIssuesByStatus } from '../store/group-issues'
import { useFollowSelectedIssue } from '../hooks/useFollowSelectedIssue'
import { KanbanCard } from './KanbanCard'
import { IssueStatusIcon, ISSUE_STATUS_LABELS } from './IssueStatusIcon'
import { cleanIpcError } from '../util/ipc-error'
import { color, fontSize } from '../style/tokens'
import type { IssueDTO, IssueStatusDTO } from '../../../shared/dto'

/** Below this, a column stops shrinking and the board scrolls horizontally instead
 * (DESIGN "Board" → "Columns"). Wide enough for a two-line name plus a project pill. */
const COLUMN_MIN_WIDTH = 220

/** Pixels of pointer movement (down → up) required for a release to commit a card move
 * instead of being treated as a plain click/select (mirrors `GROUP_DRAG_THRESHOLD_PX` in
 * `SessionTabBar.tsx` and `DIVIDER_DRAG_THRESHOLD_PX` in `SplitDividers.tsx`). */
const CARD_DRAG_THRESHOLD_PX = 4

/** The drag ghost's `zIndex` — above the drawer's own content (`zIndex: 40`) and every
 * other inline/portaled piece of the workspace, but below the shared modal `zIndex: 100`
 * (`overlayStyle`) so a dialog opened mid-drag — not expected, but not impossible — would
 * still paint over a stale ghost rather than under it. */
const GHOST_Z_INDEX = 60

function findColumnStatus(clientX: number, clientY: number): IssueStatusDTO | undefined {
  const el = document.elementFromPoint(clientX, clientY)
  const column = el?.closest<HTMLElement>('[data-issue-status]')
  return (column?.getAttribute('data-issue-status') as IssueStatusDTO | null) ?? undefined
}

export function KanbanBoard(): React.JSX.Element {
  const issues = useStore((s) => s.issues)
  const tasks = useStore((s) => s.tasks)
  const selectedIssueId = useStore((s) => s.selectedIssueId)
  const issueDraft = useStore((s) => s.issueDraft)
  const selectIssue = useStore((s) => s.selectIssue)
  const issuesDrawerOpen = useStore((s) => s.issuesDrawerOpen)
  const pushToast = useStore((s) => s.pushToast)

  const groups = groupIssuesByStatus(Object.values(issues))

  const [dragIssueId, setDragIssueId] = useState<string | undefined>(undefined)
  const [dragOverStatus, setDragOverStatus] = useState<IssueStatusDTO | undefined>(undefined)
  const ghostRef = useRef<HTMLDivElement>(null)
  // Set `true` the instant a real drag (past the threshold) is detected on release,
  // consumed once by the dragged card's `onSelect` wrapper so the click that always
  // follows a captured pointerup (same button, since pointer capture redirects the
  // mouse-compat events too) doesn't also select it.
  const justDraggedRef = useRef(false)
  // Tears down the in-flight gesture's listeners/capture and clears visual state,
  // WITHOUT sending any command — the shared exit for Esc, the drawer closing, the
  // dragged issue disappearing, and unmount. `undefined` when no drag is in flight.
  const dragCancelRef = useRef<(() => void) | undefined>(undefined)
  // The dragged card's own rect at pointerdown — read once, synchronously, by the
  // ghost's JSX below (so its first paint lands exactly over the real card, with no
  // one-frame flash at (0,0) while waiting for `ghostRef` to attach), then only ever
  // updated via `ghostRef.current.style.transform` afterwards (never through React).
  const dragOriginRef = useRef({ left: 0, top: 0, width: COLUMN_MIN_WIDTH })
  // Removes the Esc-cancel path's one-shot window `pointerup` listener (see
  // `startCardDrag`'s Esc handler) if the component unmounts before that pointerup
  // ever fires. `undefined` when no such listener is pending.
  const suppressNextClickCleanupRef = useRef<(() => void) | undefined>(undefined)

  const startCardDrag = (e: React.PointerEvent<HTMLButtonElement>, issue: IssueDTO): void => {
    if (e.button !== 0) return
    // A card that remounts mid-drag (see the class doc comment) must not leave a
    // stale suppression flag or a previous gesture's listeners around.
    justDraggedRef.current = false
    dragCancelRef.current?.()
    const target = e.currentTarget
    const win = target.ownerDocument.defaultView
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    const rect = target.getBoundingClientRect()
    dragOriginRef.current = { left: rect.left, top: rect.top, width: rect.width }
    target.setPointerCapture(pointerId)

    let dragging = false
    let ended = false
    // The column under the pointer, so `setDragOverStatus` only runs on a change. A
    // per-gesture closure variable: reading `dragOverStatus` state here would go stale.
    let lastDragOverStatus: IssueStatusDTO | undefined

    // Guards against the SAME native event reaching both the element-level listener
    // and the window-level listener below (the normal case: capture intact, the event
    // dispatches at `target` and bubbles up through `window` too) — only the first to
    // arrive tears down; the second is a no-op.
    const endDrag = (): boolean => {
      if (ended) return false
      ended = true
      dragCancelRef.current = undefined
      window.removeEventListener('keydown', onEscKeyDown, true)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onPointerCancel)
      target.removeEventListener('lostpointercapture', onLostCapture)
      win?.removeEventListener('pointerup', onWindowUp)
      win?.removeEventListener('pointercancel', onWindowCancel)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      return true
    }

    const clearVisuals = (): void => {
      setDragIssueId(undefined)
      setDragOverStatus(undefined)
      lastDragOverStatus = undefined
    }

    // Shared exit for drawer-close / issue-disappeared / unmount: tear down and clear
    // visuals, but never send a command. Esc goes through `onEscKeyDown` below instead,
    // which also arms the post-cancel click suppression.
    const cancelDrag = (): void => {
      if (!endDrag()) return
      clearVisuals()
    }
    dragCancelRef.current = cancelDrag

    // Esc cancels only the drag (see the class doc comment). Installed on `window` when
    // the threshold is crossed and removed in `endDrag`.
    const onEscKeyDown = (ke: KeyboardEvent): void => {
      if (ke.key !== 'Escape') return
      ke.stopImmediatePropagation()
      ke.preventDefault()
      cancelDrag()
      // The release that follows would otherwise fire a `click` on the original card
      // (same button, pointer capture redirects mouse-compat events too) and select
      // it — swallow that one click the same way a real drag-drop does.
      justDraggedRef.current = true
      suppressNextClickCleanupRef.current?.()
      const onPointerUpOnce = (): void => {
        window.removeEventListener('pointerup', onPointerUpOnce, true)
        suppressNextClickCleanupRef.current = undefined
        setTimeout(() => {
          justDraggedRef.current = false
        }, 0)
      }
      window.addEventListener('pointerup', onPointerUpOnce, true)
      suppressNextClickCleanupRef.current = () =>
        window.removeEventListener('pointerup', onPointerUpOnce, true)
    }

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragging) {
        if (Math.hypot(dx, dy) < CARD_DRAG_THRESHOLD_PX) return
        dragging = true
        setDragIssueId(issue.id)
        window.addEventListener('keydown', onEscKeyDown, true)
      }
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${rect.left + dx}px, ${rect.top + dy}px)`
      }
      const next = findColumnStatus(ev.clientX, ev.clientY)
      if (next !== lastDragOverStatus) {
        lastDragOverStatus = next
        setDragOverStatus(next)
      }
    }

    const onUp = (ev: PointerEvent): void => {
      const wasDragging = dragging
      if (!endDrag()) return
      if (!wasDragging) {
        clearVisuals()
        return
      }
      // Consumed by the dragged card's `onSelect` wrapper, but ALSO self-clears on a
      // macrotask so a drop that doesn't synthesize a click on this same card
      // (e.g. released outside every card) can't leave it permanently stuck.
      justDraggedRef.current = true
      setTimeout(() => {
        justDraggedRef.current = false
      }, 0)
      const dropStatus = findColumnStatus(ev.clientX, ev.clientY)
      clearVisuals()
      if (!dropStatus) return
      // Read the issue's CURRENT status from the store, not the `status` closed over
      // at drag start — something else may have changed it mid-drag.
      const currentStatus = useStore.getState().issues[issue.id]?.status
      // Same column, outside every column, or the issue vanished mid-drag: no-op, the
      // card returns (it never actually moved — only the ghost/dim did).
      if (!currentStatus || dropStatus === currentStatus) return
      void window.octopusAPI.issues.update({ issueId: issue.id, status: dropStatus }).then(
        (ack) => {
          if (!ack.ok) pushToast('error', ack.error ?? 'Failed to update status')
        },
        (err: unknown) => {
          pushToast('error', cleanIpcError(err))
        }
      )
    }

    // Capture lost without a release (tab switched away, or the capturing element was
    // removed/recreated mid-drag — see the class doc comment): drop everything, send
    // nothing.
    const onPointerCancel = (): void => cancelDrag()
    const onLostCapture = (): void => cancelDrag()
    // Window-level fallback for the silent-capture-drop case: filtered by `pointerId`
    // since `window` sees pointer events for the whole app, not just this gesture.
    const onWindowUp = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) onUp(ev)
    }
    const onWindowCancel = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) onPointerCancel()
    }

    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onPointerCancel)
    target.addEventListener('lostpointercapture', onLostCapture)
    win?.addEventListener('pointerup', onWindowUp)
    win?.addEventListener('pointercancel', onWindowCancel)
  }

  // Closing the drawer mid-drag (button or shortcut) cancels it: this component stays
  // mounted across open/close (only a tab switch unmounts it), so the drag would
  // otherwise keep its listeners and ghost alive behind the now-hidden drawer.
  useEffect(() => {
    if (!issuesDrawerOpen) dragCancelRef.current?.()
  }, [issuesDrawerOpen])

  // The dragged issue disappearing out from under the gesture (deleted elsewhere) also
  // cancels it — there is nothing left to drop.
  useEffect(() => {
    if (dragIssueId !== undefined && !issues[dragIssueId]) dragCancelRef.current?.()
  }, [dragIssueId, issues])

  // The board unmounting (a tab switch away from Board) mid-drag cancels it too, and
  // drops the Esc-cancel path's one-shot pointerup listener if it's still pending.
  useEffect(
    () => () => {
      dragCancelRef.current?.()
      suppressNextClickCleanupRef.current?.()
    },
    []
  )

  // Keep the selected card visible (see "Selection follow" in the class doc comment
  // above). Scoped to this component's own subtree (not `document`) so it can never
  // find the portaled drag ghost's `data-issue-id` copy instead of the real card.
  const boardRef = useRef<HTMLDivElement>(null)
  const selectedIssueStatus = selectedIssueId ? issues[selectedIssueId]?.status : undefined
  useFollowSelectedIssue(boardRef, issuesDrawerOpen, selectedIssueId, selectedIssueStatus)

  const draggedIssue = dragIssueId ? issues[dragIssueId] : undefined
  const draggedLinkedTask = draggedIssue?.taskId ? tasks[draggedIssue.taskId] : undefined

  return (
    <div
      ref={boardRef}
      style={{
        display: 'flex',
        height: '100%',
        width: '100%',
        overflowX: 'auto',
        overflowY: 'hidden'
      }}
    >
      {groups.map((group, index) => (
        <section
          key={group.status}
          aria-label={ISSUE_STATUS_LABELS[group.status]}
          data-issue-status={group.status}
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 0',
            minWidth: COLUMN_MIN_WIDTH,
            height: '100%',
            minHeight: 0,
            // Only between columns — the last column's own right edge is the
            // `IssuesDrawer` tabpanel wrapper's single border against `IssueDetail`;
            // giving it one too would double it up.
            borderRight: index < groups.length - 1 ? `1px solid ${color.border}` : undefined,
            background: dragOverStatus === group.status ? color.bgHover : undefined
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              padding: '6px 10px',
              borderBottom: `1px solid ${color.borderSubtle}`,
              color: color.textSecondary,
              fontSize: fontSize.sm,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em'
            }}
          >
            <IssueStatusIcon status={group.status} size={14} />
            <span>{ISSUE_STATUS_LABELS[group.status]}</span>
            <span style={{ color: color.muted, fontWeight: 400, marginLeft: 'auto' }}>
              {group.issues.length}
            </span>
          </div>

          <ul
            role="list"
            style={{
              flex: '1 1 0',
              minHeight: 0,
              margin: 0,
              padding: 8,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              overflowY: 'auto'
            }}
          >
            {group.issues.length === 0 ? (
              <li
                style={{
                  listStyle: 'none',
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: color.muted,
                  fontSize: fontSize.sm
                }}
              >
                No issues
              </li>
            ) : (
              group.issues.map((issue) => {
                const selected = !issueDraft && issue.id === selectedIssueId
                const linkedTask = issue.taskId ? tasks[issue.taskId] : undefined
                return (
                  <li key={issue.id} style={{ listStyle: 'none' }}>
                    <KanbanCard
                      issue={issue}
                      selected={selected}
                      linkedTaskName={linkedTask?.name}
                      dragging={issue.id === dragIssueId}
                      onDragPointerDown={(e) => startCardDrag(e, issue)}
                      onSelect={() => {
                        // Self-clears on a macrotask (`startCardDrag`'s `onUp`/
                        // `onEscKeyDown`) rather than here, so it only ever swallows
                        // the one click synthesized by that same pointerup.
                        if (justDraggedRef.current) return
                        selectIssue(issue.id)
                      }}
                    />
                  </li>
                )
              })
            )}
          </ul>
        </section>
      ))}

      {draggedIssue
        ? createPortal(
            <div
              ref={ghostRef}
              aria-hidden
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                width: dragOriginRef.current.width,
                zIndex: GHOST_Z_INDEX,
                pointerEvents: 'none',
                transform: `translate(${dragOriginRef.current.left}px, ${dragOriginRef.current.top}px)`
              }}
            >
              <KanbanCard
                issue={draggedIssue}
                selected={false}
                linkedTaskName={draggedLinkedTask?.name}
                onSelect={() => {}}
                ghost
              />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
