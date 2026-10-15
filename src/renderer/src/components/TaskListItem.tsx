/**
 * One task row in the `ProgressPanel` list (DESIGN §5.1/§5.4). Clicking activates
 * the task (`setActiveTask` locally + `tasks.switch` to the backend), double-click
 * renames it in place (`tasks.rename`), and the row is a dnd-kit sortable handle so
 * tasks reorder by dragging (`tasks.reorder`, reconciled by `taskReordered`).
 *
 * The row leads with the task's aggregate status icon (§5.4, §9) — the max-priority
 * roll-up over its sessions' display levels (`taskDisplayState`, folding state and
 * ready-for-review, §3.4/§9.5), computed by the panel and passed in. When not `ready`
 * it also shows a "(lifecycle)" suffix so provisioning/stale/failed states stay legible.
 *
 * A task bound to an issue (PRD "Issues" → "On the task side") also shows the issue's
 * `IssueStatusIcon`, title = the issue name, as a nested `<button>`: clicking it opens
 * the Issues drawer on that issue WITHOUT activating the task (`openIssuesDrawer`,
 * `e.stopPropagation()` so the row's own `onClick` never fires), and `onPointerDown`
 * also stops propagation so dnd-kit's `PointerSensor` (bound via `listeners` on the
 * row below) never starts a drag from it. `useSortable` is wired with only a
 * `PointerSensor` (no `KeyboardSensor`), so `listeners` carries no `onKeyDown`
 * activator today — nothing to stop propagation of there, so none is added.
 *
 * Window-view feature:
 *  - A task viewed OUTSIDE this window's group (`isViewedElsewhere`) shows an
 *    informational, non-clickable "Viewing in window" badge — in MAIN this is the
 *    only visible sign the task popped into its own window. It's deliberately
 *    OMITTED inside the view's own read-only copy of this list for its own pinned
 *    task — the badge there would be redundant (this row IS the window being
 *    described) — though it still shows for every OTHER task that has a view.
 *  - `readOnly` (set only by the VIEW window's pinned, non-interactive task list,
 *    `ProgressPanel`'s own `readOnly` prop) strips the row down to display-only: no
 *    `useSortable` drag (passed `disabled: true` rather than omitting the hook, so
 *    its identity/arity stays the same across renders), no click-to-activate, no
 *    rename (plain `<span>`, not `EditableLabel` — its double-click opens an edit
 *    input unconditionally, regardless of `onCommit`), no issue-icon button (the
 *    bound issue's `IssueStatusIcon` renders bare, not focusable/clickable), and no
 *    right-click menu — zero Tab stops in the row — plus a reduced opacity (except
 *    the viewed/active row itself, kept full-opacity so it still reads as selected
 *    among the grayed-out rest, per the product spec).
 *  - `onCreateView` (main only; omitted/undefined when `readOnly`) wires a right-click
 *    menu with the single "+ New Window From Task" item (disabled when the task
 *    already has a view, `isViewedTask`) — the non-modal `role="menu"` pattern from
 *    `SessionTab.tsx`, not a modal dialog, so it is NOT part of the
 *    `topmostModal()`/overlay contract (`.claude/rules/modals-and-overlays.md`).
 *    Portaled to `document.body` purely for z-index (see `MENU_Z_INDEX`): the menu's
 *    `minWidth` can overflow the 240px sidebar into the workspace, where the Issues
 *    drawer (`zIndex: 40`) would otherwise paint over it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EditableLabel } from './EditableLabel'
import { StatusIcon } from './StatusIcon'
import { IssueStatusIcon } from './IssueStatusIcon'
import { useStore, issueForTask, isViewedTask, isViewedElsewhere } from '../store/store'
import { color, fontSize, radius, shadow } from '../style/tokens'
import type { DisplayState } from '../store/display-state'
import type { TaskEntry } from '../store/store'

/** The row's context menu's `zIndex` once portaled to `document.body` — above the
 * Issues drawer's own content (`zIndex: 40`) and every other inline/portaled piece
 * of the workspace, but below the shared modal `zIndex: 100` (`overlayStyle`) so a
 * dialog opened while this is up would still paint over it rather than under it
 * (mirrors `KanbanBoard.tsx`'s `GHOST_Z_INDEX`). */
const MENU_Z_INDEX = 60

export interface TaskListItemProps {
  readonly task: TaskEntry
  readonly active: boolean
  readonly onActivate: () => void
  readonly onRename: (name: string) => void
  /** The resolved rollup display level for this task (§3.4/§9.5). */
  readonly display: DisplayState
  /** Indent the row under a repo header in the grouped view (§5.1). */
  readonly indent?: boolean
  /** Window-view feature (Task 5): render inert, as part of a view window's pinned
   * task list — see header comment. */
  readonly readOnly?: boolean
  /** Window-view feature (Task 2, main only): open "+ New Window From Task" for this
   * task. Omitted in the view window's `readOnly` list, which offers no menu at all. */
  readonly onCreateView?: () => void
}

export function TaskListItem({
  task,
  active,
  onActivate,
  onRename,
  display,
  indent = false,
  readOnly = false,
  onCreateView
}: TaskListItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: readOnly
  })
  // Narrow selector (DESIGN §Issues "On the task side"): `issueForTask` returns the
  // SAME issue object reference across unrelated store updates, so this row only
  // re-renders when ITS binding or the bound issue itself actually changes, not on
  // every store change.
  const boundIssue = useStore((s) => issueForTask(s, task.id))
  const openIssuesDrawer = useStore((s) => s.openIssuesDrawer)
  // `hasView`: does the task have a view AT ALL — drives the menu's disabled "+ New
  // Window From Task" (can't open a second view for the same task). `viewedElsewhere`:
  // is that view OUTSIDE this window's own group — drives the "Viewing in window"
  // badge, which must stay silent inside the view's own list for its own pinned task.
  const hasView = useStore((s) => isViewedTask(s, task.id))
  const viewedElsewhere = useStore((s) => isViewedElsewhere(s, task.id))

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const firstMenuItemRef = useRef<HTMLButtonElement>(null)
  // Whatever had focus when the menu opened, so a keyboard close (Escape/Tab) hands
  // focus back instead of dropping it to <body> (which the Issues drawer would grab).
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Dismiss on outside mousedown — mirrors `SessionTab`'s context menu — and on
  // scroll/blur/resize: the menu is `position: fixed`, so once the list scrolls it
  // would float beside a different row while still acting on this one. Escape is
  // handled primarily by the menu's own `onKeyDown` below (focus lives inside it
  // once open); this window-level listener is just the outside-click path plus a
  // fallback for the brief gap before the focus effect below runs.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  // Clamp the menu into the viewport, then focus its first item. Runs on every
  // `menu` change (including the clamp's own correction): the first pass measures
  // the just-rendered menu against the viewport and, if it overflows, replaces
  // `menu` with the clamped position; the next pass sees an already-in-bounds menu
  // and focuses it. Converges in at most two passes. Falls back to the menu
  // container itself (`tabIndex={-1}`) when the only item is disabled (`hasView`)
  // and so can't take focus — `onKeyDown` is on the container either way.
  useLayoutEffect(() => {
    if (!menu) return
    const el = menuRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const clampedX = Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4))
      const clampedY = Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4))
      if (clampedX !== menu.x || clampedY !== menu.y) {
        setMenu({ x: clampedX, y: clampedY })
        return
      }
    }
    firstMenuItemRef.current?.focus()
    if (document.activeElement !== firstMenuItemRef.current) el?.focus()
  }, [menu])

  const openMenu = (e: React.MouseEvent): void => {
    if (readOnly || !onCreateView) return
    e.preventDefault()
    e.stopPropagation()
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMenu({ x: e.clientX, y: e.clientY })
  }

  // Every key stops here so a chord (Ctrl+Shift+Arrow, Ctrl+Shift+W, ...) typed
  // while this menu is focused never reaches the window-level shortcut listener
  // underneath (`useKeyboardShortcuts`) and acts on the task behind it.
  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      setMenu(null)
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Move focus among items — a no-op today since there's only ever one
      // ("+ New Window From Task"); kept explicit so a future second item only
      // needs to fill this branch in, not re-derive the key contract.
      e.preventDefault()
      return
    }
    // Enter/Space: no handling needed — the focused button's own native "activate
    // on Enter/Space" default action already fires its `onClick` (stopping
    // propagation above doesn't suppress that; only `preventDefault` would).
  }

  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : readOnly && !active ? 0.55 : 1,
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    textAlign: 'left',
    padding: indent ? '7px 12px 7px 24px' : '7px 12px',
    background: active ? color.bgSelected : 'transparent',
    color: active ? color.text : color.textSecondary,
    boxShadow: active ? `inset 2px 0 0 ${color.accent}` : 'none',
    cursor: readOnly ? 'default' : 'pointer',
    boxSizing: 'border-box',
    position: 'relative'
  }

  return (
    <li ref={setNodeRef} style={{ listStyle: 'none' }}>
      <div
        {...(readOnly ? {} : attributes)}
        {...(readOnly ? {} : listeners)}
        className="task-row"
        role="button"
        aria-pressed={active}
        aria-disabled={readOnly}
        aria-label={viewedElsewhere ? `${task.name}, viewing in window` : task.name}
        onClick={readOnly ? undefined : onActivate}
        onContextMenu={openMenu}
        style={rowStyle}
      >
        <span
          style={{ display: 'inline-flex', width: 16, justifyContent: 'center', marginRight: 6 }}
        >
          <StatusIcon display={display} />
        </span>
        {readOnly ? (
          // Plain text, not `EditableLabel`: its double-click unconditionally opens
          // an edit input regardless of `onCommit`, so a no-op `onCommit` alone
          // would NOT make this row non-interactive.
          <span style={{ flex: 1, minWidth: 0 }}>{task.name}</span>
        ) : (
          <EditableLabel
            value={task.name}
            onCommit={onRename}
            editAriaLabel="rename task"
            style={{ flex: 1, minWidth: 0 }}
          />
        )}
        {boundIssue ? (
          readOnly ? (
            // No `<button>` wrapper: bare, non-focusable, non-clickable — zero Tab
            // stops in a readOnly row.
            <span title={boundIssue.name} style={{ marginLeft: 6, display: 'inline-flex' }}>
              <IssueStatusIcon status={boundIssue.status} title={boundIssue.name} />
            </span>
          ) : (
            <button
              type="button"
              aria-label={`Open issue ${boundIssue.name}`}
              title={boundIssue.name}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                openIssuesDrawer(boundIssue.id)
              }}
              style={{
                marginLeft: 6,
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                display: 'inline-flex'
              }}
            >
              <IssueStatusIcon status={boundIssue.status} title={boundIssue.name} />
            </button>
          )
        ) : null}
        {task.lifecycle !== 'ready' ? (
          <span style={{ marginLeft: 6, color: color.muted, fontSize: fontSize.sm }}>
            ({task.lifecycle})
          </span>
        ) : null}
        {/* Window-view feature: informational only, never clickable (own badge, not
            a nested interactive control — unlike the issue button above). Omitted
            inside the view's own list for its own pinned task (`viewedElsewhere` is
            false there) — redundant with the window the user is already looking at. */}
        {viewedElsewhere ? (
          <span
            title="This task is open in its own window"
            style={{
              marginLeft: 6,
              padding: '1px 6px',
              borderRadius: radius.pill,
              background: color.infoBg,
              color: color.infoText,
              fontSize: fontSize.sm,
              whiteSpace: 'nowrap'
            }}
          >
            Viewing in window
          </span>
        ) : null}
      </div>

      {menu
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="task actions"
              tabIndex={-1}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onMenuKeyDown}
              style={{
                position: 'fixed',
                top: menu.y,
                left: menu.x,
                zIndex: MENU_Z_INDEX,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 200,
                padding: 4,
                background: color.bgSurfaceRaised,
                border: `1px solid ${color.border}`,
                borderRadius: radius.md,
                boxShadow: shadow.md
              }}
            >
              <button
                ref={firstMenuItemRef}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={hasView}
                title={hasView ? 'This task already has a window' : undefined}
                onClick={() => {
                  setMenu(null)
                  onCreateView?.()
                }}
                style={{ width: '100%', textAlign: 'left', padding: '6px 8px', cursor: 'pointer' }}
              >
                + New Window From Task
              </button>
            </div>,
            document.body
          )
        : null}
    </li>
  )
}
