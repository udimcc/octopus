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
  const activeSessionId = useStore((s) => s.activeSessionByTask[taskId])
  const setActiveSession = useStore((s) => s.setActiveSession)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const sessionIds = task ? task.sessionIds : []

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

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = sessionIds.indexOf(String(active.id))
    const to = sessionIds.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    // arrayMove only to compute the destination index for the command; the store
    // updates when `sessionReordered` comes back.
    const reordered = arrayMove([...sessionIds], from, to)
    const toIndex = reordered.indexOf(String(active.id))
    void window.octopusAPI.sessions.reorder({ taskId, sessionId: String(active.id), toIndex })
  }

  const scrollBy = (dx: number): void => {
    scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' })
  }

  const jumpTo = (sid: string): void => {
    setMenuOpen(false)
    setActiveSession(taskId, sid)
  }

  const canAddSession = task?.lifecycle === 'ready'

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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
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
