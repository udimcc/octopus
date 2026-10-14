/**
 * The New-Task modal's "Associated issue" dropdown ("Issues"). A custom listbox
 * rather than a native `<select>`: an `<option>` can only hold text, and the issue
 * window draws status as `IssueStatusIcon` SVGs — this picker shows the very same
 * icons, so a status looks identical in both places.
 *
 * Not a dialog: the popup is an absolutely-positioned list inside the modal card, so
 * it adds nothing to the `topmostModal()` contract (`.claude/rules/modals-and-overlays.md`).
 * Escape while it is open closes only the popup (stopped before the card's own
 * Escape-closes-the-modal handler); an outside mousedown or Tab also closes it.
 * Keyboard: ArrowDown/Enter/Space on the trigger opens it onto the selected (else
 * first enabled) entry; ArrowUp/ArrowDown move between enabled entries; Enter/Space
 * pick (native `<button>` activation).
 */

import { useEffect, useRef, useState } from 'react'
import { IssueStatusIcon } from './IssueStatusIcon'
import { color, fontSize, radius, shadow } from '../style/tokens'
import type { IssueDTO } from '../../../shared/dto'

export interface IssuePickerProps {
  /** The pickable issues, already filtered and ordered by the caller. */
  readonly issues: readonly IssueDTO[]
  /** The selected issue id; `undefined` = "None". */
  readonly value: string | undefined
  /** `''` = "None" was picked. */
  readonly onChange: (issueId: string) => void
  readonly disabled: boolean
  /** Entries for which this is true are shown but can't be picked. */
  readonly isUnavailable: (issue: IssueDTO) => boolean
  /** Text shown after an unavailable entry's name, e.g. "(already linked)". */
  readonly unavailableNote: string
}

// `justifyContent` overrides the global `button { justify-content: center }`
// (globals.css), which would center an entry's icon + name.
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: 8,
  width: '100%',
  minWidth: 0,
  textAlign: 'left'
}

const nameStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

export function IssuePicker({
  issues,
  value,
  onChange,
  disabled,
  isUnavailable,
  unavailableNote
}: IssuePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = value !== undefined ? issues.find((i) => i.id === value) : undefined

  // Close on an outside click (only listening while open).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // The pickable entries, in display order ("None" first).
  const enabledOptions = (): HTMLButtonElement[] =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    ).filter((b) => !b.disabled)

  // On open, focus the selected entry (else the first pickable one).
  useEffect(() => {
    if (!open) return
    const options = enabledOptions()
    const current = options.find((b) => b.getAttribute('aria-selected') === 'true')
    ;(current ?? options[0])?.focus({ preventScroll: true })
  }, [open])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  const pick = (issueId: string): void => {
    onChange(issueId)
    close()
  }

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation() // close the popup only, not the whole modal
      close()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const options = enabledOptions()
    if (options.length === 0) return
    const at = options.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'ArrowDown'
        ? Math.min(at + 1, options.length - 1)
        : Math.max(at === -1 ? 0 : at - 1, 0)
    options[next].focus({ preventScroll: true })
  }

  const option = (
    id: string,
    content: React.ReactNode,
    unavailable: boolean
  ): React.JSX.Element => {
    const isSelected = (value ?? '') === id
    return (
      <li key={id || 'none'} role="none">
        <button
          type="button"
          role="option"
          className="menu-item"
          aria-selected={isSelected}
          aria-disabled={unavailable}
          disabled={unavailable}
          onClick={() => pick(id)}
          style={{
            ...rowStyle,
            padding: '6px 8px',
            background: isSelected ? color.bgSelected : undefined
          }}
        >
          {content}
        </button>
      </li>
    )
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="associated issue"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value ?? ''}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        style={{
          ...rowStyle,
          justifyContent: 'space-between',
          padding: 'var(--space-2) var(--space-3)',
          background: color.bgInput
        }}
      >
        <span style={{ ...rowStyle, flex: 1 }}>
          {selected ? (
            <>
              <IssueStatusIcon status={selected.status} />
              <span style={nameStyle}>{selected.name}</span>
            </>
          ) : (
            <span style={{ color: color.muted }}>None</span>
          )}
        </span>
        <span aria-hidden="true" style={{ color: color.muted, fontSize: fontSize.sm }}>
          ▾
        </span>
      </button>

      {open ? (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Issues"
          onKeyDown={onListKeyDown}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 20,
            margin: 0,
            padding: 4,
            listStyle: 'none',
            maxHeight: 260,
            overflowY: 'auto',
            background: color.bgSurfaceRaised,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            boxShadow: shadow.md
          }}
        >
          {option('', <span style={{ color: color.muted }}>None</span>, false)}
          {issues.map((issue) => {
            const unavailable = isUnavailable(issue)
            return option(
              issue.id,
              <>
                <IssueStatusIcon status={issue.status} />
                <span style={nameStyle}>{issue.name}</span>
                {unavailable ? (
                  <span
                    style={{
                      color: color.muted,
                      fontSize: fontSize.sm,
                      marginLeft: 'auto',
                      flexShrink: 0
                    }}
                  >
                    {unavailableNote}
                  </span>
                ) : null}
              </>,
              unavailable
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
