/**
 * A label that becomes an inline text input on double-click (DESIGN §5.4 — rename
 * tasks and session tabs in place). Enter commits, Escape or blur cancels. Shared
 * by `TaskListItem` (→ `tasks.rename`) and `SessionTab` (→ `sessions.rename`) so
 * the edit affordance is identical in both places.
 *
 * The component is uncontrolled while editing: it seeds a local draft from `value`
 * and only calls `onCommit` with a trimmed, changed, non-empty draft. The store is
 * still the source of truth — the actual rename lands when the backend's
 * `taskRenamed`/`sessionRenamed` event patches `value` on the next render.
 */

import { useEffect, useRef, useState } from 'react'

export interface EditableLabelProps {
  readonly value: string
  readonly onCommit: (next: string) => void
  /** Accessible name for the edit input (e.g. "rename task"). */
  readonly editAriaLabel: string
  readonly style?: React.CSSProperties
}

export function EditableLabel({
  value,
  onCommit,
  editAriaLabel,
  style
}: EditableLabelProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  // Select the whole draft when the input appears so a rename overwrites cleanly.
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const begin = (): void => {
    setDraft(value)
    setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next !== '' && next !== value) onCommit(next)
  }

  const cancel = (): void => setEditing(false)

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label={editAriaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={cancel}
        onKeyDown={(e) => {
          // Keep the chord off the terminal / global shortcuts while editing.
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') cancel()
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        style={{ font: 'inherit', ...style }}
      />
    )
  }

  return (
    <span onDoubleClick={begin} style={style}>
      {value}
    </span>
  )
}
