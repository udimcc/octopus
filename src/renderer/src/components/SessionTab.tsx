/**
 * One session tab in the `SessionTabBar` (DESIGN §5.1/§5.4). Click activates the
 * session, double-click renames it in place (`sessions.rename`), the `×` closes
 * it (`sessions.close`), and the whole tab is a dnd-kit sortable handle so tabs
 * reorder by dragging (`sessions.reorder`, reconciled by `sessionReordered`).
 *
 * Right-click opens a small context menu (mirroring the terminal's copy/paste menu
 * in `TerminalPane`) with: open a new terminal in THIS terminal's current directory,
 * rename, move to another window, and close. The "new terminal here" item resolves
 * the live cwd via `sessions.cwd` when the menu opens and stays disabled until a
 * path comes back (it's `null` for an exited/non-terminal/non-Linux session).
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

export interface SessionTabProps {
  readonly session: SessionDTO
  readonly active: boolean
  /** Play the one-shot focus flash on this (marked) tab (§5.4). */
  readonly flash?: boolean
  readonly onActivate: () => void
  readonly onRename: (title: string) => void
  readonly onClose: () => void
  /** Open a new terminal in `cwd` (the current terminal's live directory). */
  readonly onNewTerminalFromHere: (cwd: string) => void
  /** Reassign this session to another open window. */
  readonly onMoveToWindow: (targetWindowId: string) => void
  /** Manually re-evaluate this session's state now (§5.4 R1). */
  readonly onRefreshState: () => void
  /** Other open windows this session can move to (empty → the item is disabled). */
  readonly moveTargets: readonly MoveTarget[]
  /** Resolve this session's live cwd, or `null` if it can't be determined. */
  readonly resolveCwd: () => Promise<string | null>
  /** Whether "new terminal here" applies (terminal sessions only). */
  readonly canOpenHere: boolean
  /** The resolved status-icon display level (folds state + ready-for-review, §9.5). */
  readonly display: DisplayState
}

export function SessionTab({
  session,
  active,
  flash = false,
  onActivate,
  onRename,
  onClose,
  onNewTerminalFromHere,
  onMoveToWindow,
  onRefreshState,
  moveTargets,
  resolveCwd,
  canOpenHere,
  display
}: SessionTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id
  })

  const labelRef = useRef<EditableLabelHandle>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // undefined = resolving, null = unavailable, string = resolved path.
  const [cwd, setCwd] = useState<string | null | undefined>(undefined)

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
    opacity: isDragging ? 0.5 : 1,
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
