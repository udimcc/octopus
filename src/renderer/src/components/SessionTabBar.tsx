/**
 * The tab strip for one task's sessions (DESIGN §5.1/§5.4). Replaces the M5 inline
 * `.session-tabs`. Responsibilities:
 *
 *  - Render a `SessionTab` per session + the `NewSessionDropdown`.
 *  - Drag-reorder tabs (dnd-kit `SortableContext`, horizontal): a drop dispatches
 *    `sessions.reorder({ taskId, sessionId, toIndex })`; the store reconciles from
 *    the `sessionReordered` event (never optimistically, §5.2).
 *  - Handle overflow: chevron buttons scroll the strip when it overflows, and an
 *    "⋯" menu lists every tab to jump to when there are many (~8+).
 *
 * A small drag activation distance keeps a click-to-activate from being read as a
 * drag, so single clicks still switch tabs cleanly.
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
import { useStore } from '../store/store'
import { color, radius, shadow } from '../style/tokens'

export interface SessionTabBarProps {
  readonly taskId: string
}

/** Beyond this many tabs, offer the "⋯" jump menu in addition to scrolling. */
const OVERFLOW_MENU_THRESHOLD = 8

export function SessionTabBar({ taskId }: SessionTabBarProps): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const sessions = useStore((s) => s.sessions)
  const windowId = useStore((s) => s.windowId)
  const windows = useStore((s) => s.windows)
  const activeSessionId = useStore((s) => s.activeSessionByTask[taskId])
  const setActiveSession = useStore((s) => s.setActiveSession)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // Only this window's tabs (V1.5, §5.6). Reorder indices below are computed within
  // this filtered list, but the reorder command carries the session id, and the
  // backend reorders the task's full list — moving a windowed tab past a tab that
  // lives in another window is not expressible, which is the intended UX.
  const sessionIds = task ? task.sessionIds.filter((id) => sessions[id]?.windowId === windowId) : []

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

  /** Is the drop point inside this tab bar's own client rectangle? */
  const droppedInsideBar = (): boolean => {
    const bar = scrollRef.current
    if (!bar) return true
    const r = bar.getBoundingClientRect()
    // Client coords: screen minus the window's screen origin (window.screenX/Y).
    const cx = lastScreen.current.x - window.screenX
    const cy = lastScreen.current.y - window.screenY
    const margin = 20 // §5.6: leaving the bar by ~20px reads as a detach intent.
    return (
      cx >= r.left - margin &&
      cx <= r.right + margin &&
      cy >= r.top - margin &&
      cy <= r.bottom + margin
    )
  }

  const detach = (sessionId: string): void => {
    const { x, y } = lastScreen.current
    void window.octopusAPI.windows.windowAtPoint({ x, y }).then((targetWindowId) => {
      if (targetWindowId === windowId) return // dropped back on our own window: no-op.
      if (targetWindowId) {
        void window.octopusAPI.sessions.move({ sessionId, targetWindowId })
      } else {
        // Empty desktop → open a new secondary window hosting this session, placed
        // near the drop point (atomic create-then-move, §6.7).
        void window.octopusAPI.windows.createWithSession({
          sessionId,
          bounds: { x, y, width: 900, height: 640 }
        })
      }
    })
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    const sessionId = String(active.id)

    // Dropped outside the tab bar → detach to another window / new window (§5.6).
    if (!droppedInsideBar()) {
      detach(sessionId)
      return
    }

    // Inside the bar → reorder (unchanged). No-op if dropped on itself/no target.
    if (!over || active.id === over.id) return
    const from = sessionIds.indexOf(sessionId)
    const to = sessionIds.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    // arrayMove only to compute the destination index for the command; the store
    // updates when `sessionReordered` comes back.
    const reordered = arrayMove([...sessionIds], from, to)
    const toIndex = reordered.indexOf(sessionId)
    void window.octopusAPI.sessions.reorder({ taskId, sessionId, toIndex })
  }

  const scrollBy = (dx: number): void => {
    scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' })
  }

  const jumpTo = (sid: string): void => {
    setMenuOpen(false)
    setActiveSession(taskId, sid)
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
            {sessionIds.map((sid) => {
              const s = sessions[sid]
              if (!s) return null
              return (
                <SessionTab
                  key={sid}
                  session={s}
                  active={sid === activeSessionId}
                  onActivate={() => setActiveSession(taskId, sid)}
                  onRename={(title) => window.octopusAPI.sessions.rename({ sessionId: sid, title })}
                  onClose={() => window.octopusAPI.sessions.close({ sessionId: sid })}
                  canOpenHere={s.config.kind === 'terminal'}
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
                  moveTargets={moveTargets}
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
    </div>
  )
}
