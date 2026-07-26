/**
 * The "+ New Session" control (DESIGN §5.4, §8). Its menu is populated from
 * `store.sessionTypes`, which the backend already filters by `availableFromVersion`
 * — so V1 shows exactly one entry (Terminal) and V3's Jenkins type appears with no
 * change here. Choosing a type dispatches `sessions.create({ taskId, typeId })`;
 * the resulting `sessionCreated` event adds and activates the tab.
 *
 * With a single type the button creates immediately (no menu to disambiguate);
 * with several it toggles a small dropdown. Disabled unless the task is `ready`
 * (a worktree must exist before a session can spawn in it, §6.4).
 */

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/store'
import { color } from '../style/tokens'

export interface NewSessionDropdownProps {
  readonly taskId: string
  readonly disabled: boolean
}

export function NewSessionDropdown({
  taskId,
  disabled
}: NewSessionDropdownProps): React.JSX.Element {
  const sessionTypes = useStore((s) => s.sessionTypes)
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
    void window.octopusAPI.sessions.create({ taskId, typeId })
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
        aria-label="new session"
        aria-haspopup={types.length > 1}
        aria-expanded={types.length > 1 ? open : undefined}
        disabled={disabled}
        onClick={onClick}
        style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
      >
        + Session
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
            background: color.modalBg,
            border: `1px solid ${color.border}`,
            borderRadius: 4,
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
            minWidth: 160
          }}
        >
          {types.map((t) => (
            <li key={t.typeId}>
              <button
                type="button"
                role="menuitem"
                onClick={() => create(t.typeId)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 8px',
                  border: 'none',
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
