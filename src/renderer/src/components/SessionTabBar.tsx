/**
 * The tab strip for one task's sessions (DESIGN §5.1/§5.4/§5.7). Replaces the M5 inline
 * `.session-tabs`. Responsibilities:
 *
 *  - Render a `SessionTab` per session + the `NewSessionDropdown`.
 *  - Drag-reorder tabs (dnd-kit `SortableContext`, horizontal): a drop dispatches
 *    `sessions.reorder({ taskId, sessionId, toIndex })`; the store reconciles from the
 *    `sessionReordered` event (never optimistically, §5.2). `toIndex` is computed against
 *    the task's FULL session order (`task.sessionIds`, every window), NOT the window-
 *    filtered list rendered here — the domain (`Task.reorderSession`, `src/domain/task.ts`)
 *    applies it to the full order, and it alone owns the snapping/clamping rules (a group
 *    member stays within its own group's span, a lone tab snaps to the nearer edge of any
 *    group it would otherwise land inside, `Task.clampToGroupSpan`/`Task.snapInsertionIndex`)
 *    — the renderer sends the raw intended index and lets the backend correct it; it does
 *    NOT reimplement those rules. Only the FINAL dropped index matters — the live drag-over
 *    preview dnd-kit renders mid-drag is computed against the window-filtered list (purely
 *    visual, kept simple to reason about); the backend is authoritative regardless, so an
 *    out-of-span preview snaps back the instant `sessionReordered` lands, same as any other
 *    backend-corrected drag in this app.
 *  - Handle overflow: chevron buttons scroll the strip when it overflows, and an "⋯" menu
 *    lists every tab to jump to when there are many (~8+); it dispatches through the same
 *    `activate` as a tab click.
 *  - Split groups (§5.7, split-groups design): color each grouped tab's bottom-edge line
 *    from `GROUP_COLOR_PALETTE[group.colorIndex]` (`style/tokens.ts`), bridging the gap to
 *    the next tab when it's a fellow member so a group's whole span reads as one
 *    continuous line (`groupColor`/`lineBridgesNext` on `SessionTab`). That line IS the
 *    group's drag handle: a manual (non-dnd-kit — multiple DOM nodes can't share one
 *    dnd-kit draggable id) pointer-capture drag (`startGroupDrag`/`finishGroupDrag`,
 *    modeled on `SplitDividers`'s gutter-drag pattern) that either reorders the whole
 *    group's block within the bar (`groups.reorder`, `toIndex` likewise computed against
 *    `task.sessionIds`) or, dropped outside the bar, detaches the group's representative
 *    member — the window's mark if it's in this group, else the group's first member —
 *    through the SAME cross-window move/detach path a lone tab uses (`detach`, shared via
 *    `insideBar`). A pointer-down on the line only STARTS tracking; it only becomes a drag
 *    (and only then shows the `grabbing`/dimmed feedback) once the pointer has moved past
 *    `GROUP_DRAG_THRESHOLD_PX`, and only a primary-button press is considered at all — so a
 *    plain click passes through as a click, never a drop (IMP5). `hitTestTabId` resolves
 *    the drop target tab by its `data-session-id` attribute (set on each `SessionTab`'s
 *    root), not by pairing a DOM query's order with this bar's own `sessionIds` array.
 *    Right-click the line opens a one-item "Ungroup" menu (`groups.ungroup`). "Split
 *    right"/"Split down" on a tab's own context menu join it into the window's mark's
 *    group (`groups.join`); their enablement (`evaluateSplitMenu`) is a DOM read
 *    (`measurePane`), so `SessionTab` only calls it when its own menu opens, never on every
 *    render here — it reads activeTaskId/mark/group from a single `useStore.getState()`
 *    snapshot so none of those three can disagree. "Remove from group" leaves a member's
 *    group (`groups.leave`).
 *  - A tab click only ever moves this window's mark (`activate` → `setActiveSession` +
 *    `sessions.switch`) — there is no replace/split logic here or in the store's
 *    `withMark`; which group (if any) is shown for a task is driven entirely by which
 *    session is marked (`TaskView` resolves it via `groupOfSession`, store.ts).
 *
 * A small drag activation distance keeps a click-to-activate from being read as a drag, so
 * single clicks still switch tabs cleanly.
 */

import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { SessionTab } from './SessionTab'
import { NewSessionDropdown } from './NewSessionDropdown'
import {
  useStore,
  sessionDisplayState,
  isSessionFocused,
  activeSessionInWindow
} from '../store/store'
import { hasLeaf, canSplit } from '../store/split-layout'
import { measurePane } from '../terminal/terminal-metrics'
import { color, radius, shadow, GROUP_COLOR_PALETTE } from '../style/tokens'
import type { GroupDTO } from '../../../shared/dto'

export interface SessionTabBarProps {
  readonly taskId: string
}

/** Beyond this many tabs, offer the "⋯" jump menu in addition to scrolling. */
const OVERFLOW_MENU_THRESHOLD = 8

/**
 * A stable empty-array reference for the `groupsByTask[taskId] ?? EMPTY_GROUPS` selector
 * below. `?? []` would allocate a NEW array every call, which breaks the referential-
 * stability contract zustand's `useSyncExternalStore`-backed `useStore` relies on — a
 * selector that returns a different reference each time the store is read (even though
 * nothing changed) makes React think the snapshot changed on every render, which here
 * manifested as an infinite re-render loop ("Maximum update depth exceeded").
 */
const EMPTY_GROUPS: readonly GroupDTO[] = []

/** Pixels of pointer movement before a group-line pointer-down becomes a drag (IMP5) —
 * below this, releasing is treated as a plain click (which the line's own `onClick`
 * stop-propagation in `SessionTab` already keeps from activating the tab underneath). */
const GROUP_DRAG_THRESHOLD_PX = 4

export function SessionTabBar({ taskId }: SessionTabBarProps): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const sessions = useStore((s) => s.sessions)
  const hasUnseenFinishedTurn = useStore((s) => s.hasUnseenFinishedTurn)
  const windowId = useStore((s) => s.windowId)
  const windows = useStore((s) => s.windows)
  // This task's split groups (§5.7). `groupFor` below is the per-session lookup every
  // tab (color, drag handle, split-menu enablement) goes through.
  const groups = useStore((s) => s.groupsByTask[taskId] ?? EMPTY_GROUPS)
  // THIS window's marked tab (§3.7). Each window marks its own; reading a shared pointer
  // left no tab marked here once focus moved to a session hosted in another window.
  const activeSessionId = useStore((s) => activeSessionInWindow(s, taskId, s.windowId))
  // Focus flash (§5.4): the marked tab of the on-screen task, while the flash is on.
  const flashing = useStore((s) => s.focusFlashOn && s.activeTaskId === taskId)
  const setActiveSession = useStore((s) => s.setActiveSession)
  // Subscribe to the on-screen inputs so a tab's icon recomputes when window focus or
  // the active task changes (§9.5): the review dot is suppressed at DISPLAY time for an
  // on-screen session, so a focus change with no state change must still re-render.
  // `isSessionFocused` reads the settled values off `useStore.getState()` below.
  useStore((s) => s.windowFocused)
  useStore((s) => s.activeTaskId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [lineMenu, setLineMenu] = useState<{ x: number; y: number; groupId: string } | null>(null)
  // The group whose line is currently mid-drag (past GROUP_DRAG_THRESHOLD_PX), for the
  // dimmed/`grabbing` visual feedback on its own tabs (§5.7, IMP5). Undefined otherwise.
  const [draggingGroupId, setDraggingGroupId] = useState<string | undefined>(undefined)

  // Only this window's tabs (V1.5, §5.6) — used for RENDERING (visual order/adjacency)
  // only. `fullOrder` (the task's full cross-window order) is what reorder commands'
  // `toIndex` must be computed against (IMP4) — the domain (`Task.reorderSession`/
  // `reorderGroup`, `src/domain/task.ts`) applies it to the full list, not a per-window
  // slice, and already owns the group-span clamping/snapping rules. Group members always
  // share a window (I "members share a window"), so a group's span stays contiguous in
  // the window-filtered list too — it's a safe list for VISUAL adjacency, just not index
  // math sent to the backend.
  const sessionIds = task ? task.sessionIds.filter((id) => sessions[id]?.windowId === windowId) : []
  const fullOrder = task ? task.sessionIds : []

  const groupFor = (sid: string): GroupDTO | undefined => groups.find((g) => hasLeaf(g.layout, sid))
  /** `group`'s member ids, in actual tab order (mirrors `Task.tabOrderedLeafIds`). */
  const membersOf = (group: GroupDTO): string[] =>
    sessionIds.filter((id) => groupFor(id)?.id === group.id)

  // Track whether the strip overflows so the chevrons only show when useful.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [sessionIds.length])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Cross-window detach (V1.5, §5.6): track the pointer's SCREEN coords during a tab
  // drag. dnd-kit's drag events don't carry screenX/screenY, so we sample them from a
  // window-level `pointermove` active only while dragging. On release we hit-test:
  // dropped inside this bar → reorder (below); dropped elsewhere → detach.
  const lastScreen = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      lastScreen.current = { x: e.screenX, y: e.screenY }
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  const onDragStart = (e: DragStartEvent): void => {
    // Seed the screen position from the activator so a drop with no intervening
    // pointermove still has coords (defensive; a real drag always moves).
    const activator = e.activatorEvent
    if (activator instanceof PointerEvent) {
      lastScreen.current = { x: activator.screenX, y: activator.screenY }
    }
  }

  /** Is `(screenX, screenY)` inside this tab bar's own client rectangle (±margin)? */
  const insideBar = (screenX: number, screenY: number): boolean => {
    const bar = scrollRef.current
    if (!bar) return true
    const r = bar.getBoundingClientRect()
    // Client coords: screen minus the window's screen origin (window.screenX/Y).
    const cx = screenX - window.screenX
    const cy = screenY - window.screenY
    const margin = 20 // §5.6: leaving the bar by ~20px reads as a detach intent.
    return (
      cx >= r.left - margin &&
      cx <= r.right + margin &&
      cy >= r.top - margin &&
      cy <= r.bottom + margin
    )
  }

  const detach = (sessionId: string, screenX: number, screenY: number): void => {
    void window.octopusAPI.windows
      .windowAtPoint({ x: screenX, y: screenY })
      .then((targetWindowId) => {
        if (targetWindowId === windowId) return // dropped back on our own window: no-op.
        if (targetWindowId) {
          void window.octopusAPI.sessions.move({ sessionId, targetWindowId })
        } else {
          // Empty desktop → open a new secondary window hosting this session, placed
          // near the drop point (atomic create-then-move, §6.7).
          void window.octopusAPI.windows.createWithSession({
            sessionId,
            bounds: { x: screenX, y: screenY, width: 900, height: 640 }
          })
        }
      })
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    const sessionId = String(active.id)

    // Dropped outside the tab bar → detach to another window / new window (§5.6).
    if (!insideBar(lastScreen.current.x, lastScreen.current.y)) {
      detach(sessionId, lastScreen.current.x, lastScreen.current.y)
      return
    }

    // Inside the bar → reorder. No-op if dropped on itself/no target. `over.id` is
    // always a member of this bar's window-filtered `sessionIds` (it comes from THIS
    // `SortableContext`), but the index sent to the backend is computed against the
    // task's FULL order (IMP4): the domain's `Task.reorderSession` clamps/snaps against
    // every session of the task, not a per-window slice, and already owns that logic —
    // this just moves `sessionId` to the same relative spot within the full order and
    // sends the raw resulting index.
    if (!over || active.id === over.id) return
    const overId = String(over.id)
    const from = fullOrder.indexOf(sessionId)
    const to = fullOrder.indexOf(overId)
    if (from < 0 || to < 0) return
    const toIndex = arrayMove([...fullOrder], from, to).indexOf(sessionId)
    void window.octopusAPI.sessions.reorder({ taskId, sessionId, toIndex }).then((ack) => {
      if (!ack.ok) useStore.getState().pushToast('error', ack.error ?? 'Failed to move tab')
    })
  }

  /** Which tab's center is nearest `screenX` right now — a manual `closestCenter`.
   * Reads each tab's own `data-session-id` (set by `SessionTab`) rather than pairing a
   * DOM query's result order with this bar's `sessionIds` array by index (IMP5) — the
   * two could silently drift out of sync (e.g. a tab that returns `null` and isn't
   * rendered) and swap in the wrong session. */
  const hitTestTabId = (screenX: number): string | undefined => {
    const bar = scrollRef.current
    if (!bar) return undefined
    const clientX = screenX - window.screenX
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>('[data-session-id]'))
    let bestId: string | undefined
    let bestDist = Infinity
    tabs.forEach((el) => {
      const sid = el.dataset.sessionId
      if (!sid) return
      const r = el.getBoundingClientRect()
      const dist = Math.abs(clientX - (r.left + r.width / 2))
      if (dist < bestDist) {
        bestDist = dist
        bestId = sid
      }
    })
    return bestId
  }

  // Tears down an in-flight group-line drag; run on unmount (e.g. the bar unmounts mid-drag).
  const groupDragEndRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => groupDragEndRef.current?.(), [])

  /**
   * Finish a group-line drag (§5.7): dropped outside the bar → detach the group's
   * representative member (the mark if it's in this group, else the group's first
   * member) through the same cross-window path a lone tab uses. Dropped inside the bar
   * on a tab that's already a member of this group → no-op (same final order). Otherwise
   * → reorder the whole block: collapse every OTHER member out of a copy of the task's
   * FULL order (IMP4 — not the window-filtered `sessionIds`; `Task.reorderGroup` clamps/
   * snaps against the full order and already owns that logic), keeping the first member
   * as a stand-in at its own slot, `arrayMove` that stand-in to the drop target exactly
   * like a single-tab drag, then read its resulting index — which lands on the same
   * "block excluded" scale `groups.reorder`'s `toIndex` expects (mirrors
   * `Task.reorderGroup`'s own `rest`).
   */
  const finishGroupDrag = (
    screenX: number,
    screenY: number,
    groupId: string,
    memberIds: readonly string[]
  ): void => {
    if (!insideBar(screenX, screenY)) {
      const representative =
        activeSessionId && memberIds.includes(activeSessionId) ? activeSessionId : memberIds[0]
      if (representative) detach(representative, screenX, screenY)
      return
    }
    const overId = hitTestTabId(screenX)
    if (!overId || memberIds.includes(overId)) return // dropped within its own span: no-op.
    const representative = memberIds[0]
    if (!representative) return
    const memberSet = new Set(memberIds)
    const moveList = fullOrder.filter((id) => id === representative || !memberSet.has(id))
    const fromIdx = moveList.indexOf(representative)
    const overIdx = moveList.indexOf(overId)
    if (fromIdx < 0 || overIdx < 0) return
    const toIndex = arrayMove([...moveList], fromIdx, overIdx).indexOf(representative)
    void window.octopusAPI.groups.reorder({ taskId, groupId, toIndex }).then((ack) => {
      if (!ack.ok) useStore.getState().pushToast('error', ack.error ?? 'Failed to move group')
    })
  }

  /** Pointer-down on a group's line (§5.7): a manual pointer-capture drag of the whole
   * group, modeled on `SplitDividers`'s gutter drag — dnd-kit can't register multiple DOM
   * nodes under one draggable id, so the group-as-a-block drag can't reuse its machinery
   * directly; this reuses `insideBar`/`detach`/`hitTestTabId` instead.
   *
   * IMP5: a plain click is a pointerdown immediately followed by a pointerup with ~zero
   * movement, and without a threshold that was read as a completed drag — issuing a
   * `groups.reorder`/detach for what the user meant as a click. Capture starts tracking
   * immediately (so a fast drag isn't missed), but `finishGroupDrag` only fires, and the
   * `grabbing`/dimmed visual only shows, once the pointer has moved past
   * `GROUP_DRAG_THRESHOLD_PX`. Also ignores anything but a primary-button press.
   *
   * Stuck-drag defense: in Electron 33, removing the capturing element from the DOM
   * mid-drag (a re-render recreates the tab/line it's attached to — e.g. the group's own
   * tabs reorder, or it dissolves) drops pointer capture SILENTLY — no
   * `lostpointercapture` fires — so the subsequent `pointerup`/`pointercancel` goes to
   * whatever is under the pointer and bubbles to `window` instead, never reaching the
   * now-detached element, and `draggingGroupId` would stay stuck set (dimmed tabs
   * forever). `pointerup`/`pointercancel` are therefore listened for BOTH on the
   * capturing element and on `window` (`target.ownerDocument.defaultView`), the latter
   * filtered by `pointerId`; both route through the same end/finish logic, and `endDrag`
   * guards on a local `ended` flag so the normal case — where the SAME event reaches both
   * listeners via bubbling — only ends the drag once. `lostpointercapture` is still
   * listened for too, for an explicit release that doesn't involve removing the element.
   * The effect below additionally ends the drag if the group it's dragging stops existing
   * (dissolved/ungrouped) even without any pointer event at all. */
  const startGroupDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    groupId: string,
    memberIds: readonly string[]
  ): void => {
    if (e.button !== 0) return
    const target = e.currentTarget
    const win = target.ownerDocument.defaultView
    const pointerId = e.pointerId
    const startX = e.screenX
    const startY = e.screenY
    let dragging = false
    target.setPointerCapture(pointerId)
    // Guards against the SAME native event reaching both the element-level listener and
    // the window-level listener below (the normal case: capture intact, the event
    // dispatches at `target` and bubbles up through `window` too) — only the first to
    // arrive tears down and acts; the second is a no-op.
    let ended = false
    const endDrag = (): boolean => {
      if (ended) return false
      ended = true
      groupDragEndRef.current = undefined
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onCancel)
      target.removeEventListener('lostpointercapture', onLostCapture)
      win?.removeEventListener('pointerup', onWindowUp)
      win?.removeEventListener('pointercancel', onWindowCancel)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      if (dragging) setDraggingGroupId(undefined)
      return true
    }
    const onMove = (ev: PointerEvent): void => {
      if (dragging) return
      const dx = ev.screenX - startX
      const dy = ev.screenY - startY
      if (Math.hypot(dx, dy) < GROUP_DRAG_THRESHOLD_PX) return
      dragging = true
      setDraggingGroupId(groupId)
    }
    const onUp = (ev: PointerEvent): void => {
      const wasDragging = dragging
      if (!endDrag()) return
      if (wasDragging) finishGroupDrag(ev.screenX, ev.screenY, groupId, memberIds)
    }
    const onCancel = (): void => {
      endDrag()
    }
    const onLostCapture = (): void => {
      endDrag()
    }
    // Window-level fallback for the silent-capture-drop case (see the doc comment above):
    // filtered by `pointerId` since `window` sees pointer events for the whole app, not
    // just this gesture.
    const onWindowUp = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) onUp(ev)
    }
    const onWindowCancel = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) onCancel()
    }
    groupDragEndRef.current?.()
    groupDragEndRef.current = () => {
      endDrag()
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onCancel)
    target.addEventListener('lostpointercapture', onLostCapture)
    win?.addEventListener('pointerup', onWindowUp)
    win?.addEventListener('pointercancel', onWindowCancel)
  }

  // End a stuck group-line drag if the group it's dragging stops existing (dissolved by
  // a concurrent `groups.leave`/`ungroup`, or this task's `groupsByTask` otherwise
  // changing out from under it) — the pointer-event cleanup above only fires on an actual
  // pointer event, which a dissolved-with-no-further-input gesture would never get.
  useEffect(() => {
    if (draggingGroupId && !groups.some((g) => g.id === draggingGroupId)) {
      groupDragEndRef.current?.()
    }
  }, [groups, draggingGroupId])

  // Dismiss the group-line "Ungroup" menu on an outside mousedown or Escape.
  useEffect(() => {
    if (!lineMenu) return
    const close = (): void => setLineMenu(null)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setLineMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [lineMenu])

  const scrollBy = (dx: number): void => {
    scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' })
  }

  // Activate a session tab. Update THIS window's pointer locally for instant feedback,
  // then round-trip through the loop (`sessions.switch`) — exactly as the keyboard cycle
  // and `TaskListItem` do. The round-trip persists the active-tab pointer (I10) and
  // broadcasts `activeSessionChanged` to EVERY window, so the ready-for-review clear on
  // focus (§9.5) reaches the main window's task rollup even when this session is hosted
  // in another window. A local-only click left that task dot lit (bug 2.x). This only
  // ever moves the mark (§5.7) — the store's `withMark` is a pure mark setter with no
  // replace/split logic, so which group (if any) is shown follows from the mark alone
  // (`TaskView`'s `groupOfSession` lookup). The "⋯" jump menu below reuses this same
  // `activate`.
  const activate = (sid: string): void => {
    setActiveSession(taskId, sid)
    void window.octopusAPI.sessions.switch({ sessionId: sid })
  }

  const jumpTo = (sid: string): void => {
    setMenuOpen(false)
    activate(sid)
  }

  /**
   * Tab-menu "Split right"/"Split down" enablement (§5.7), evaluated fresh when a tab's
   * context menu opens — not on every render, since it ends in a DOM read (`measurePane`,
   * via `canSplit`). Disabled when `sid` IS the mark, `sid` is already a member of the
   * mark's group, this bar isn't showing the active task (a stale bar's split would
   * silently target the wrong task), there is no mark to split next to, or the mark's
   * pane is too small to halve. Reads `activeTaskId`, the mark, AND the mark's group all
   * from the SAME `useStore.getState()` snapshot — using the component-scoped `groups`
   * (subscribed at the last render) for the group lookup instead would mix a possibly
   * one-render-stale value in with the otherwise-fresh `data`.
   */
  const evaluateSplitMenu = (
    sid: string
  ): { splitRightDisabled: boolean; splitDownDisabled: boolean } => {
    const data = useStore.getState()
    const disabled = { splitRightDisabled: true, splitDownDisabled: true }
    if (data.activeTaskId !== taskId) return disabled
    const mark = activeSessionInWindow(data, taskId, data.windowId)
    if (!mark || sid === mark) return disabled
    const groupsNow = data.groupsByTask[taskId] ?? EMPTY_GROUPS
    const markGroup = groupsNow.find((g) => hasLeaf(g.layout, mark))
    if (markGroup && hasLeaf(markGroup.layout, sid)) return disabled
    const m = measurePane(mark)
    const fits = (dir: 'row' | 'col'): boolean =>
      !m || canSplit(m.widthPx, m.heightPx, m.cellWidthPx, m.cellHeightPx, dir)
    return { splitRightDisabled: !fits('row'), splitDownDisabled: !fits('col') }
  }

  const canAddSession = task?.lifecycle === 'ready'

  // Human labels for the "Move to window" menu. Windows carry no name, so the main
  // window is "Main window" and secondaries are numbered "Window N" in creation
  // order (array order — event-created windows share createdAt 0, §6.7). The number
  // is stable across tabs; the current window is excluded from each tab's targets.
  const secondaries = windows.filter((w) => w.role === 'secondary')
  const windowLabel = (id: string): string => {
    const win = windows.find((w) => w.id === id)
    if (!win || win.role === 'main') return 'Main window'
    return `Window ${secondaries.indexOf(win) + 1}`
  }
  const moveTargets = windows
    .filter((w) => w.id !== windowId)
    .map((w) => ({ id: w.id, label: windowLabel(w.id) }))

  return (
    <div
      className="session-tabs"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 4,
        padding: '6px 6px 0',
        background: color.bgSurface,
        borderBottom: `1px solid ${color.border}`
      }}
    >
      {overflowing ? (
        <button
          type="button"
          className="icon-button"
          aria-label="scroll tabs left"
          onClick={() => scrollBy(-160)}
        >
          ‹
        </button>
      ) : null}

      <div
        ref={scrollRef}
        role="tablist"
        style={{
          display: 'flex',
          gap: 4,
          overflowX: 'auto',
          flex: 1,
          minWidth: 0,
          scrollbarWidth: 'none'
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={[...sessionIds]} strategy={horizontalListSortingStrategy}>
            {sessionIds.map((sid, idx) => {
              const s = sessions[sid]
              if (!s) return null
              const group = groupFor(sid)
              const groupColor = group
                ? GROUP_COLOR_PALETTE[group.colorIndex % GROUP_COLOR_PALETTE.length]
                : undefined
              const nextSid = sessionIds[idx + 1]
              const lineBridgesNext =
                group !== undefined && nextSid !== undefined && groupFor(nextSid)?.id === group.id
              return (
                <SessionTab
                  key={sid}
                  session={s}
                  active={sid === activeSessionId}
                  flash={flashing && sid === activeSessionId}
                  groupColor={groupColor}
                  lineBridgesNext={lineBridgesNext}
                  groupSize={group ? membersOf(group).length : undefined}
                  groupDragging={group !== undefined && group.id === draggingGroupId}
                  onActivate={() => activate(sid)}
                  onRename={(title) => window.octopusAPI.sessions.rename({ sessionId: sid, title })}
                  onClose={() => window.octopusAPI.sessions.close({ sessionId: sid })}
                  onSplitRight={() => {
                    if (activeSessionId) {
                      void window.octopusAPI.groups
                        .join({
                          sessionId: sid,
                          anchorSessionId: activeSessionId,
                          dir: 'row'
                        })
                        .then((ack) => {
                          if (!ack.ok) {
                            useStore.getState().pushToast('error', ack.error ?? 'Failed to split')
                          }
                        })
                    }
                  }}
                  onSplitDown={() => {
                    if (activeSessionId) {
                      void window.octopusAPI.groups
                        .join({
                          sessionId: sid,
                          anchorSessionId: activeSessionId,
                          dir: 'col'
                        })
                        .then((ack) => {
                          if (!ack.ok) {
                            useStore.getState().pushToast('error', ack.error ?? 'Failed to split')
                          }
                        })
                    }
                  }}
                  onLeaveGroup={
                    group
                      ? () =>
                          void window.octopusAPI.groups.leave({ sessionId: sid }).then((ack) => {
                            if (!ack.ok) {
                              useStore
                                .getState()
                                .pushToast('error', ack.error ?? 'Failed to remove from group')
                            }
                          })
                      : undefined
                  }
                  evaluateSplitEnablement={() => evaluateSplitMenu(sid)}
                  canOpenHere={s.config.kind === 'terminal'}
                  display={sessionDisplayState(
                    s,
                    hasUnseenFinishedTurn[sid] === true,
                    isSessionFocused(useStore.getState(), sid)
                  )}
                  resolveCwd={() => window.octopusAPI.sessions.cwd({ sessionId: sid })}
                  onNewTerminalFromHere={(cwd) =>
                    window.octopusAPI.sessions.create({
                      taskId,
                      typeId: s.typeId,
                      config: { kind: 'terminal', cwdOverride: cwd }
                    })
                  }
                  onMoveToWindow={(targetWindowId) =>
                    window.octopusAPI.sessions.move({ sessionId: sid, targetWindowId })
                  }
                  onRefreshState={() => window.octopusAPI.sessions.refreshState({ sessionId: sid })}
                  moveTargets={moveTargets}
                  onLinePointerDown={
                    group ? (e) => startGroupDrag(e, group.id, membersOf(group)) : undefined
                  }
                  onLineContextMenu={
                    group
                      ? (e) => setLineMenu({ x: e.clientX, y: e.clientY, groupId: group.id })
                      : undefined
                  }
                />
              )
            })}
          </SortableContext>
        </DndContext>
      </div>

      {overflowing ? (
        <button
          type="button"
          className="icon-button"
          aria-label="scroll tabs right"
          onClick={() => scrollBy(160)}
        >
          ›
        </button>
      ) : null}

      {sessionIds.length > OVERFLOW_MENU_THRESHOLD ? (
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="icon-button"
            aria-label="all sessions"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <ul
              role="menu"
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                zIndex: 20,
                margin: 0,
                padding: 4,
                listStyle: 'none',
                background: color.bgSurfaceRaised,
                border: `1px solid ${color.border}`,
                borderRadius: radius.md,
                boxShadow: shadow.md,
                maxHeight: 320,
                overflowY: 'auto',
                minWidth: 180
              }}
            >
              {sessionIds.map((sid) => {
                const s = sessions[sid]
                if (!s) return null
                return (
                  <li key={sid}>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => jumpTo(sid)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '6px 8px',
                        background: sid === activeSessionId ? color.bgSelected : 'transparent',
                        cursor: 'pointer'
                      }}
                    >
                      {s.title}
                      {s.lifecycle === 'exited' ? ' (exited)' : ''}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      <NewSessionDropdown taskId={taskId} disabled={!canAddSession} />

      {lineMenu ? (
        <div
          role="menu"
          aria-label="group actions"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: lineMenu.y,
            left: lineMenu.x,
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 140,
            padding: 4,
            background: color.bgSurfaceRaised,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            boxShadow: shadow.md
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              void window.octopusAPI.groups
                .ungroup({ taskId, groupId: lineMenu.groupId })
                .then((ack) => {
                  if (!ack.ok) {
                    useStore.getState().pushToast('error', ack.error ?? 'Failed to ungroup')
                  }
                })
              setLineMenu(null)
            }}
            style={{ width: '100%', textAlign: 'left', padding: '6px 8px', cursor: 'pointer' }}
          >
            Ungroup
          </button>
        </div>
      ) : null}
    </div>
  )
}
