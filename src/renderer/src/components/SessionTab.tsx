/**
 * One session tab in the `SessionTabBar` (DESIGN §5.1/§5.4). Click activates the
 * session, double-click renames it in place (`sessions.rename`), the `×` closes
 * it (`sessions.close`), and the whole tab is a dnd-kit sortable handle so tabs
 * reorder by dragging (`sessions.reorder`, reconciled by `sessionReordered`).
 *
 * Right-click opens a small context menu (mirroring the terminal's copy/paste menu
 * in `TerminalPane`), in order: open a new terminal in THIS terminal's current
 * directory, split right, split down, rename, move to another window, refresh
 * state, remove from group (members only), and close session. The "new terminal
 * here" item resolves the live cwd via `sessions.cwd` when the menu opens and stays
 * disabled until a path comes back (it's `null` for an exited/non-terminal/non-Linux
 * session).
 *
 * Split groups (DESIGN §5.7, split-groups design): `groupColor`, set only when this
 * session is a member of one of its task's groups, draws a thin colored strip along
 * this tab's bottom edge — the caller (`SessionTabBar`) computes the color from the
 * group's `colorIndex` and the group-palette tokens. `lineBridgesNext` extends that
 * strip across the tab-bar's flex gap into the NEXT tab's slot when it is a fellow
 * member, so a group's whole span reads as one continuous line rather than N
 * separate segments — purely a `right` offset, no DOM measurement. The strip is
 * also this tab's group-drag handle (`onLinePointerDown`, a taller invisible hit
 * area) and carries its own "Ungroup" menu (`onLineContextMenu`); both stop
 * propagation (pointerdown/contextmenu AND click) so they never also trigger this
 * tab's own sortable drag, context menu, or activation — `SessionTabBar` only
 * commits a group-drag past a small movement threshold, so a plain click on the
 * line is just a (swallowed) click, never a drop. `groupDragging` dims this tab and
 * switches the line's cursor to `grabbing` while ITS group is the one being dragged
 * (set by `SessionTabBar` once that threshold is crossed). "Split right"/"Split
 * down" join THIS tab's session into the window's marked session's group next to
 * its pane (forming one if the mark is lone); their enablement is evaluated fresh by
 * the caller when the menu opens (`evaluateSplitEnablement`, a DOM read via
 * `measurePane`), not during render. "Remove from group" only appears while this tab
 * is actually a member (`groupColor` set) and leaves its group, which dissolves at 1
 * remaining member.
 *
 * A dead session (`lifecycle === 'exited'`) keeps its tab — the buffer is still
 * readable (§6.1) — and shows an "(exited)" suffix.
 */

import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EditableLabel, type EditableLabelHandle } from './EditableLabel'
import { StatusIcon } from './StatusIcon'
import { color, radius, shadow } from '../style/tokens'
import type { DisplayState } from '../store/display-state'
import type { SessionDTO } from '../../../shared/dto'

/** A window this session can be moved to, with a human label ("Main window"/"Window 2"). */
export interface MoveTarget {
  readonly id: string
  readonly label: string
}

/** Pixel height of the invisible hit area under the group-line strip (DESIGN §5.7). Kept
 * INSIDE the tab's own box (anchored to its bottom edge, not overflowing past it) so it
 * never eats into the tab bar's scroll area, and short enough that most of the tab above
 * it still activates on a plain click. */
const GROUP_LINE_HIT_PX = 6
/** Pixel height of the visible colored strip itself. */
const GROUP_LINE_PX = 3
/** Must match the tab bar's `role="tablist"` flex `gap` (`SessionTabBar.tsx`) — the
 * amount a bridging segment extends past its own tab to cover the gap to the next. */
const TAB_GAP_PX = 4

export interface SessionTabProps {
  readonly session: SessionDTO
  readonly active: boolean
  /** Play the one-shot focus flash on this (marked) tab (§5.4). */
  readonly flash?: boolean
  /** This session's group color (DESIGN §5.7, split-groups design); undefined if lone. */
  readonly groupColor?: string
  /** The next tab in order is a fellow member of the same group — bridge the gap (§5.7). */
  readonly lineBridgesNext?: boolean
  /** Member count of this session's group, for the line's `aria-label` (§5.7); only
   * meaningful (and only read) while `groupColor` is set. */
  readonly groupSize?: number
  /** This session's group is the one currently being drag-reordered as a block (§5.7):
   * dims this tab and shows `grabbing` on the line, same visual language as a dnd-kit
   * single-tab drag's own `isDragging`. */
  readonly groupDragging?: boolean
  readonly onActivate: () => void
  readonly onRename: (title: string) => void
  readonly onClose: () => void
  /** Open a new terminal in `cwd` (the current terminal's live directory). */
  readonly onNewTerminalFromHere: (cwd: string) => void
  /** Reassign this session to another open window. */
  readonly onMoveToWindow: (targetWindowId: string) => void
  /** Manually re-evaluate this session's state now (§5.4 R1). */
  readonly onRefreshState: () => void
  /** "Split right" (§5.7): join this tab's session into the mark's group, row-wise. */
  readonly onSplitRight?: () => void
  /** "Split down" (§5.7): join this tab's session into the mark's group, column-wise. */
  readonly onSplitDown?: () => void
  /** "Remove from group" (§5.7, members only): this session becomes lone again. */
  readonly onLeaveGroup?: () => void
  /**
   * Fresh enablement for the two split items, read by the caller when the menu opens
   * (a DOM measurement via `measurePane`, so it must not run on every render).
   */
  readonly evaluateSplitEnablement?: () => {
    readonly splitRightDisabled: boolean
    readonly splitDownDisabled: boolean
  }
  /** Other open windows this session can move to (empty → the item is disabled). */
  readonly moveTargets: readonly MoveTarget[]
  /** Resolve this session's live cwd, or `null` if it can't be determined. */
  readonly resolveCwd: () => Promise<string | null>
  /** Whether "new terminal here" applies (terminal sessions only). */
  readonly canOpenHere: boolean
  /** The resolved status-icon display level (folds state + ready-for-review, §9.5). */
  readonly display: DisplayState
  /**
   * Pointer-down on this tab's group-line strip — starts dragging the WHOLE group
   * (DESIGN §5.7). Absent for a lone tab (no strip is rendered at all).
   */
  readonly onLinePointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void
  /** Right-click on this tab's group-line strip — opens the group's "Ungroup" menu (§5.7). */
  readonly onLineContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void
}

export function SessionTab({
  session,
  active,
  flash = false,
  groupColor,
  lineBridgesNext = false,
  groupSize,
  groupDragging = false,
  onActivate,
  onRename,
  onClose,
  onNewTerminalFromHere,
  onMoveToWindow,
  onRefreshState,
  onSplitRight,
  onSplitDown,
  onLeaveGroup,
  evaluateSplitEnablement,
  moveTargets,
  resolveCwd,
  canOpenHere,
  display,
  onLinePointerDown,
  onLineContextMenu
}: SessionTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id
  })

  const labelRef = useRef<EditableLabelHandle>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // undefined = resolving, null = unavailable, string = resolved path.
  const [cwd, setCwd] = useState<string | null | undefined>(undefined)
  const [splitEnablement, setSplitEnablement] = useState({
    splitRightDisabled: true,
    splitDownDisabled: true
  })

  const openMenu = (e: React.MouseEvent): void => {
    // The tab is a dnd-kit drag handle: stop the event so a right-click neither
    // starts a drag nor shows the OS menu.
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
    if (canOpenHere) {
      setCwd(undefined)
      void resolveCwd().then((c) => setCwd(c))
    }
    // Fresh enablement on every open (§5.7): the mark or its group may have changed
    // since the last time this menu was open.
    setSplitEnablement(
      evaluateSplitEnablement?.() ?? { splitRightDisabled: true, splitDownDisabled: true }
    )
  }

  // Dismiss the menu on an outside mousedown or Escape (mirrors TerminalPane).
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging || groupDragging ? 0.5 : 1,
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    borderColor: active ? color.accent : 'transparent',
    borderRadius: '4px 4px 0 0',
    background: active ? color.bgApp : 'transparent',
    color: active ? color.text : color.textSecondary,
    fontWeight: active ? 500 : 400,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  }

  const exited = session.lifecycle === 'exited'
  const menuItemStyle: React.CSSProperties = {
    width: '100%',
    textAlign: 'left',
    padding: '6px 8px',
    cursor: 'pointer'
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={flash ? 'session-tab session-tab--focus-flash' : 'session-tab'}
      role="tab"
      aria-selected={active}
      aria-label={session.title}
      data-session-id={session.id}
      onClick={onActivate}
      onContextMenu={openMenu}
      style={style}
    >
      {/* Live status glyph (§5.4, §9). Suppressed for a dead session — its "(exited)"
          suffix already tells the story and no state is being evaluated anymore. */}
      {exited ? null : <StatusIcon display={display} />}
      <EditableLabel
        ref={labelRef}
        value={session.title}
        onCommit={onRename}
        editAriaLabel="rename session"
      />
      {exited ? <span style={{ color: color.muted, fontWeight: 400 }}>(exited)</span> : null}
      <span
        role="button"
        className="tab-close"
        aria-label="close session"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        style={{
          marginLeft: 2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          color: color.muted
        }}
      >
        ✕
      </span>

      {/* Group line (§5.7): a colored strip along this tab's bottom edge, present only
          while this session is a member of a group. `lineBridgesNext` extends it past
          this tab's own right edge to cover the tab-bar's gap to the next tab, so a
          group of adjacent tabs reads as ONE continuous line. The outer box is a taller
          invisible hit area (the group's drag handle); both handlers stop propagation
          so they never also start this tab's own sortable drag or open its own menu. */}
      {groupColor ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Group of ${groupSize ?? 2} tabs`}
          data-group-line="true"
          onPointerDown={(e) => {
            e.stopPropagation()
            onLinePointerDown?.(e)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onLineContextMenu?.(e)
          }}
          // A plain click (pointerdown+up with no drag) must not also activate this
          // tab — `onActivate` is bound on the OUTER tab div and this strip sits
          // inside it, so without this the click would bubble straight into it (IMP5).
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: 0,
            right: lineBridgesNext ? -TAB_GAP_PX : 0,
            bottom: 0,
            height: GROUP_LINE_HIT_PX,
            cursor: groupDragging ? 'grabbing' : 'grab'
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: GROUP_LINE_PX,
              background: groupColor
            }}
          />
        </div>
      ) : null}

      {menu ? (
        <div
          role="menu"
          aria-label="session actions"
          // Stop mousedown here so the window-level dismiss listener doesn't close the
          // menu before a button's click lands. Stop click so activating the tab
          // (the parent's onClick) doesn't fire from inside the menu.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: menu.y,
            left: menu.x,
            zIndex: 20,
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
          {canOpenHere ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={cwd == null}
              onClick={() => {
                if (cwd) onNewTerminalFromHere(cwd)
                setMenu(null)
              }}
              style={menuItemStyle}
            >
              New terminal from this directory
            </button>
          ) : null}
          {/* "Split right"/"Split down" (§5.7): join THIS tab's session into the window's
              marked session's group next to its pane. Disabled when this tab IS the mark,
              already a member of the mark's group, or the focused pane is too small —
              `evaluateSplitEnablement` decided that fresh when the menu opened. */}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={splitEnablement.splitRightDisabled}
            onClick={() => {
              onSplitRight?.()
              setMenu(null)
            }}
            style={menuItemStyle}
          >
            Split right
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={splitEnablement.splitDownDisabled}
            onClick={() => {
              onSplitDown?.()
              setMenu(null)
            }}
            style={menuItemStyle}
          >
            Split down
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMenu(null)
              labelRef.current?.beginEdit()
            }}
            style={menuItemStyle}
          >
            Rename tab
          </button>
          {moveTargets.length === 0 ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              disabled
              style={menuItemStyle}
            >
              Move to window
            </button>
          ) : (
            moveTargets.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  onMoveToWindow(t.id)
                  setMenu(null)
                }}
                style={menuItemStyle}
              >
                Move to {t.label}
              </button>
            ))
          )}
          {/* Manually re-evaluate the live state (§5.4 R1). A dead session evaluates
              no state (its icon is suppressed), so the item is only offered while alive. */}
          {exited ? null : (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                onRefreshState()
                setMenu(null)
              }}
              style={menuItemStyle}
            >
              Refresh state
            </button>
          )}
          {/* "Remove from group" (§5.7): this session becomes lone again, its tab placed
              right after the group (a group of 2 dissolves). Only offered while this tab
              is actually a member — unlike "Close session" below, the session itself
              stays alive. */}
          {groupColor ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                onLeaveGroup?.()
                setMenu(null)
              }}
              style={menuItemStyle}
            >
              Remove from group
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onClose()
              setMenu(null)
            }}
            style={menuItemStyle}
          >
            Close session
          </button>
        </div>
      ) : null}
    </div>
  )
}
