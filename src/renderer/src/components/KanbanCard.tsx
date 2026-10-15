/**
 * A single compact card on the Board tab (PRD "Issues" → "Board"; DESIGN
 * `docs/plans/kanban-board_2026-10-14-design.md` → "Board" and "Drag-and-drop").
 * Mirrors `IssueList`'s row look (selected highlight, project pill, linked-task chip)
 * but as a card: the name clamps to two lines instead of one, and there is no status
 * icon (the column it sits in already says that).
 *
 * Kept prop-driven (no store reads): `KanbanBoard` owns
 * every bit of drag state and wires it in through props rather than this component
 * reading the store itself. `data-issue-id` is the drag/drop hook point, and
 * `KanbanBoard` also renders a second instance of this same component — undimmed,
 * `pointerEvents: 'none'`, no `onDragPointerDown` — as the portaled drag ghost that
 * follows the pointer (see `KanbanBoard`'s doc comment), so the ghost always looks
 * exactly like the real card with zero duplicated markup.
 *
 * `dragging` dims the ORIGINAL card in place during its own drag (DESIGN
 * "Drag-and-drop" → "Feel"); `onDragPointerDown`, wired to the button's
 * `onPointerDown`, is the pointer-capture drag entry point — the manual
 * pointer-capture-plus-window-fallback pattern from `SplitDividers.tsx` /
 * `SessionTabBar.tsx`'s `startGroupDrag`, implemented in `KanbanBoard` (this
 * component stays a plain prop sink, same as `onSelect`).
 *
 * VDI constraint (DESIGN "Notes for implementation"): no box-shadow, blur, filter or
 * transition/animation anywhere, including the dim (`opacity` set directly, not
 * transitioned; `.kanban-card` in globals.css also disables the global button
 * transition and adds its own hover tint, matching `.issue-row`'s). The selected
 * highlight reuses `IssueList`'s inset-shadow look as a same-width transparent/accent
 * `borderLeft` instead of an actual `boxShadow`, so size never changes between states.
 *
 * `ghost`, set only by the portaled drag-copy instance in `KanbanBoard`, renders a
 * non-interactive `<div>` instead of a `<button>` — same classes and inline style, so
 * it looks identical — with `aria-hidden`, no `tabIndex` and no handlers, so the copy
 * that follows the pointer is never itself a focusable/clickable control (it used to
 * be a second real `<button>`, reachable by Tab and clickable where it happened to sit
 * on screen).
 */

import { LinkGlyph } from './IssueStatusIcon'
import { repoBasename } from '../store/group-tasks'
import { color, fontSize, radius } from '../style/tokens'
import type { IssueDTO } from '../../../shared/dto'

/** Clamp to at most two lines, then ellipsis. `-webkit-box` is plain paint — safe on
 * the GPU-less VDI — and is what Chromium (Electron's renderer) implements this with. */
const nameClampStyle: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden'
}

export interface KanbanCardProps {
  readonly issue: IssueDTO
  readonly selected: boolean
  /** The linked task's current name, if `issue.taskId` resolves to one. Looked up by
   * the caller (as `IssueList` does), since this component never reads the store. */
  readonly linkedTaskName?: string
  readonly onSelect: () => void
  /** True while THIS card is the one being dragged — dims it in place. Omitted (or
   * `false`) for every other card, and for the drag ghost copy. */
  readonly dragging?: boolean
  /** The card button's `onPointerDown` — `KanbanBoard`'s drag entry point. Omitted on
   * the ghost copy, which must not itself be draggable. */
  readonly onDragPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void
  /** Render as a non-interactive, `aria-hidden` element instead of a `<button>` — set
   * only by the portaled drag-copy that follows the pointer (see the class doc comment). */
  readonly ghost?: boolean
}

export function KanbanCard({
  issue,
  selected,
  linkedTaskName,
  onSelect,
  dragging,
  onDragPointerDown,
  ghost
}: KanbanCardProps): React.JSX.Element {
  const style: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    width: '100%',
    padding: '8px 10px',
    // Unselected background (base + hover tint) lives in `.kanban-card`'s CSS: an
    // inline value would override its `:hover` rule, the same reasoning as
    // `IssueList`'s row.
    background: selected ? color.bgSelected : undefined,
    border: `1px solid ${color.border}`,
    borderLeft: `3px solid ${selected ? color.accent : 'transparent'}`,
    borderRadius: radius.md,
    textAlign: 'left',
    cursor: ghost ? 'default' : 'pointer',
    opacity: dragging ? 0.4 : 1
  }

  const content = (
    <>
      <span
        style={{
          ...nameClampStyle,
          color: color.text,
          fontWeight: selected ? 600 : 500
        }}
      >
        {issue.name}
      </span>
      {issue.projectPath || linkedTaskName ? (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6,
            fontSize: fontSize.sm
          }}
        >
          {issue.projectPath ? (
            <span
              className="issue-row-project"
              title={issue.projectPath}
              style={{
                padding: '0 6px',
                border: `1px solid ${color.border}`,
                borderRadius: radius.pill,
                color: color.textSecondary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%'
              }}
            >
              {repoBasename(issue.projectPath)}
            </span>
          ) : null}
          {linkedTaskName ? (
            <span
              className="issue-row-task"
              title={`Linked task: ${linkedTaskName}`}
              style={{
                color: color.accent,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%'
              }}
            >
              <LinkGlyph /> {linkedTaskName}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  )

  if (ghost) {
    return (
      <div className="kanban-card" data-issue-id={issue.id} aria-hidden style={style}>
        {content}
      </div>
    )
  }

  return (
    <button
      type="button"
      className="kanban-card"
      data-issue-id={issue.id}
      aria-pressed={selected}
      onClick={onSelect}
      onPointerDown={onDragPointerDown}
      style={style}
    >
      {content}
    </button>
  )
}
