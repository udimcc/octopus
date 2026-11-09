/**
 * The issue status icon (DESIGN "Issues" §13.1). Purely presentational: maps one
 * {@link IssueStatusDTO} to a small inline SVG/color/label. No icon library (same
 * convention as {@link StatusIcon}), and a distinct icon set: issue status is a fixed
 * 5-value workflow the user sets directly (via the status `<select>` or a link), not a
 * live signal, so none of these animate. Inline SVG is plain paint, so it's
 * SwiftShader-safe on the VDI.
 */

import { color } from '../style/tokens'
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_ORDER } from '../store/issue-status'
import type { IssueStatusDTO } from '../../../shared/dto'

/** Each shape is drawn in a 16×16 box with `currentColor`. */
const SHAPES: Readonly<Record<IssueStatusDTO, React.JSX.Element>> = {
  // Not started: a dashed outline circle.
  todo: (
    <circle
      cx="8"
      cy="8"
      r="6.25"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      pathLength={24}
      strokeDasharray="2 1"
    />
  ),
  // Running: a play triangle inside a circle.
  in_progress: (
    <>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 5.25 L11 8 L6.5 10.75 Z" fill="currentColor" />
    </>
  ),
  // Stuck: a "no entry" sign (circle with a horizontal bar).
  blocked: (
    <>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4.5 8 H11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </>
  ),
  // Being looked at: an eye.
  in_review: (
    <>
      <path
        d="M1.25 8 C3.5 2.25 12.5 2.25 14.75 8 C12.5 13.75 3.5 13.75 1.25 8 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.5" fill="currentColor" />
    </>
  ),
  // Finished: a bold check that spans the whole box.
  done: (
    <path
      d="M2 8.75 L6.25 13 L14 3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
}

const COLORS: Readonly<Record<IssueStatusDTO, string>> = {
  todo: color.muted,
  in_progress: color.statusWorking,
  blocked: color.errorText,
  in_review: color.accent,
  done: color.successText
}

/**
 * Re-exported from the canonical `store/issue-status.ts` table so existing imports
 * (`IssueDetail`, `IssueList`) keep working unchanged — this module
 * is no longer where the order/labels are DEFINED, only where they're also used
 * (for the glyph) and re-exported from.
 */
export { ISSUE_STATUS_LABELS, ISSUE_STATUS_ORDER }

export interface IssueStatusIconProps {
  readonly status: IssueStatusDTO
  /** px; the glyph scales with the surrounding text by default. */
  readonly size?: number
  /**
   * Override the `aria-label`/`title` text. The task row uses this to show the
   * bound issue's NAME on hover instead of its status label.
   */
  readonly title?: string
}

/** A small chain-link mark for a linked-task chip (inline SVG, like the status icons
 * above — no host font has a ⛓ glyph outside the color-emoji font). Shared by
 * `IssueList`'s row and `KanbanCard`'s card, which both show the same chip. */
export function LinkGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: '-0.125em' }}
    >
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  )
}

export function IssueStatusIcon({ status, size, title }: IssueStatusIconProps): React.JSX.Element {
  const label = title ?? ISSUE_STATUS_LABELS[status]
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="issue-status-icon"
      data-status={status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: COLORS[status],
        fontSize: size ?? '1em',
        lineHeight: 1,
        flex: '0 0 auto'
      }}
    >
      <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
        {SHAPES[status]}
      </svg>
    </span>
  )
}
