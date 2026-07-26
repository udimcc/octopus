/**
 * One session tab in the `SessionTabBar` (DESIGN §5.1/§5.4). Click activates the
 * session, double-click renames it in place (`sessions.rename`), the `×` closes
 * it (`sessions.close`), and the whole tab is a dnd-kit sortable handle so tabs
 * reorder by dragging (`sessions.reorder`, reconciled by `sessionReordered`).
 *
 * A dead session (`lifecycle === 'exited'`) keeps its tab — the buffer is still
 * readable (§6.1) — and shows an "(exited)" suffix.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EditableLabel } from './EditableLabel'
import { color } from '../style/tokens'
import type { SessionDTO } from '../../../shared/dto'

export interface SessionTabProps {
  readonly session: SessionDTO
  readonly active: boolean
  readonly onActivate: () => void
  readonly onRename: (title: string) => void
  readonly onClose: () => void
}

export function SessionTab({
  session,
  active,
  onActivate,
  onRename,
  onClose
}: SessionTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderStyle: 'solid',
    borderWidth: '1px 1px 0 1px',
    borderColor: active ? color.border : 'transparent',
    borderRadius: '4px 4px 0 0',
    background: active ? color.modalBg : 'transparent',
    fontWeight: active ? 'bold' : 'normal',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  }

  const exited = session.lifecycle === 'exited'

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      aria-label={session.title}
      onClick={onActivate}
      style={style}
    >
      <EditableLabel value={session.title} onCommit={onRename} editAriaLabel="rename session" />
      {exited ? <span style={{ color: color.muted, fontWeight: 'normal' }}>(exited)</span> : null}
      <span
        role="button"
        aria-label="close session"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        style={{ marginLeft: 2, cursor: 'pointer', color: color.muted }}
      >
        ×
      </span>
    </div>
  )
}
