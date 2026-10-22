/**
 * The "+ New Session" control (DESIGN §5.4, §8). Its menu is populated
 * from `store.sessionTypes`, which the backend already filters by `availableFromVersion`
 * — so V1 shows exactly one entry (Terminal) and V3's Jenkins type appears with no
 * change here. Choosing a type dispatches `sessions.create({ taskId, typeId })`;
 * the resulting `sessionCreated` event adds and activates the tab.
 *
 * With a single type the button creates immediately (no menu to disambiguate);
 * with several it toggles a small dropdown. Disabled unless the task is `ready`
 * (a worktree must exist before a session can spawn in it, §6.4).
 *
 * Label: a task with no tabs yet shows the full "+ Session" label
 * (`.btn-primary`, teal fill) so the control reads clearly on its own; once the task has
 * at least one tab, it shrinks to a compact ghost "+" at tab height (`.new-session-ghost`,
 * no fill) so it reads as "the next tab slot" rather than competing with the real tabs.
 * The session count here goes through the `sessionIdsInWindow` selector; `SessionTabBar`
 * computes its own tab list with an equivalent inline filter rather than this selector
 * (its result must stay a referentially-stable value across renders for zustand's
 * `useSyncExternalStore`-backed `useStore`, which a selector returning a freshly
 * `.filter()`-ed array on every call cannot give it — see the `EMPTY_GROUPS` comment
 * there) — the two are kept logically equivalent so both still agree on "has tabs".
 */

import { useEffect, useRef, useState } from 'react'
import { useStore, sessionIdsInWindow } from '../store/store'
import { color, radius, shadow } from '../style/tokens'

export interface NewSessionDropdownProps {
  readonly taskId: string
  readonly disabled: boolean
}

export function NewSessionDropdown({
  taskId,
  disabled
}: NewSessionDropdownProps): React.JSX.Element {
  const sessionTypes = useStore((s) => s.sessionTypes)
  const pushToast = useStore((s) => s.pushToast)
  const hasSessions = useStore((s) => sessionIdsInWindow(s, taskId, s.windowId).length > 0)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close the menu on an outside click (only mounted while open).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const create = (typeId: string): void => {
    setOpen(false)
    window.octopusAPI.sessions
      .create({ taskId, typeId })
      .then((ack) => {
        if (!ack.ok) pushToast('error', ack.error ?? 'Failed to create session')
      })
      .catch(() => pushToast('error', 'Failed to create session'))
  }

  // Fall back to a lone "terminal" entry if the type list hasn't hydrated yet.
  const types =
    sessionTypes.length > 0
      ? sessionTypes
      : [
          {
            typeId: 'terminal',
            displayName: 'Terminal',
            icon: '',
            availableFromVersion: 1,
            configSchema: {}
          }
        ]

  const onClick = (): void => {
    if (types.length === 1) create(types[0].typeId)
    else setOpen((v) => !v)
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className={hasSessions ? 'new-session-ghost' : 'btn-primary'}
        aria-label="new session"
        aria-haspopup={types.length > 1}
        aria-expanded={types.length > 1 ? open : undefined}
        disabled={disabled}
        onClick={onClick}
        style={hasSessions ? undefined : { padding: '4px 10px', whiteSpace: 'nowrap' }}
      >
        {hasSessions ? '+' : '+ Session'}
      </button>
      {open && types.length > 1 ? (
        <ul
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 20,
            margin: 0,
            padding: 4,
            listStyle: 'none',
            background: color.bgSurfaceRaised,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            boxShadow: shadow.md,
            minWidth: 160
          }}
        >
          {types.map((t) => (
            <li key={t.typeId}>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => create(t.typeId)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 8px',
                  background: 'transparent',
                  cursor: 'pointer'
                }}
              >
                {t.icon ? `${t.icon} ` : ''}
                {t.displayName}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
