/**
 * The session/task status icon (DESIGN §5.4, §3.3, §9). Renders the state lattice
 * — `unknown | waiting | working | blocked` — as a small colored glyph with the
 * product's UI vocabulary (§3.3): **Working**, **Idle** (`waiting`), **Needs input**
 * (`blocked`). `unknown` renders nothing (no signal yet → no icon, matching V1).
 *
 * A separate `readyForReview` flag (§9.5) is NOT a lattice state: it decorates an
 * otherwise-Idle session that *just* finished while unfocused ("wants your eyes").
 * When set it wins the glyph — a filled dot in the accent color — regardless of the
 * underlying `waiting` state, and its label becomes "Ready for review".
 *
 * Pure + presentational: the state string and the flag come from the store; this
 * file owns only the glyph/color/label mapping (one source of truth for both the
 * tab and the task-list variants). No icon library — glyphs are inline text so they
 * cost nothing and render identically under SwiftShader (no GPU, per project notes).
 */

import { color } from '../style/tokens'

/** The wire/domain state string (SessionDTO.state / TaskEntry.state). */
export type StatusState = 'unknown' | 'waiting' | 'working' | 'blocked'

interface Glyph {
  readonly glyph: string
  readonly color: string
  readonly label: string
  /** A subtle pulse conveys "in progress"; static states don't animate. */
  readonly pulse?: boolean
}

/** State → glyph/color/label. `unknown` is absent (renders nothing). */
const GLYPHS: Readonly<Record<Exclude<StatusState, 'unknown'>, Glyph>> = {
  // ● teal, gently pulsing — Claude thinking / a foreground command running.
  working: { glyph: '●', color: color.accent, label: 'Working', pulse: true },
  // ○ muted hollow — at a prompt / turn finished (the product's "Idle").
  waiting: { glyph: '○', color: color.muted, label: 'Idle' },
  // ▲ warning — a permission/attention request ("Needs input").
  blocked: { glyph: '▲', color: color.errorText, label: 'Needs input' }
}

/** The ready-for-review decoration (§9.5): overrides the glyph on an idle session. */
const REVIEW_GLYPH: Glyph = { glyph: '●', color: color.accent, label: 'Ready for review' }

export interface StatusIconProps {
  readonly state: string
  /** §9.5 highlight — when true, overrides an idle glyph with the review dot. */
  readonly readyForReview?: boolean
  /** px; the glyph scales with the surrounding text by default. */
  readonly size?: number
}

/**
 * Resolve the glyph to show, or `null` for nothing (unknown & not ready-for-review).
 * Exported for unit tests and the two call sites that want the aria-label.
 */
export function resolveGlyph(state: string, readyForReview?: boolean): Glyph | null {
  if (readyForReview) return REVIEW_GLYPH
  if (state === 'working' || state === 'waiting' || state === 'blocked') return GLYPHS[state]
  return null
}

export function StatusIcon({ state, readyForReview, size }: StatusIconProps): React.JSX.Element | null {
  const g = resolveGlyph(state, readyForReview)
  if (!g) return null
  return (
    <span
      role="img"
      aria-label={g.label}
      title={g.label}
      className={g.pulse ? 'status-icon status-pulse' : 'status-icon'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: g.color,
        fontSize: size ?? '0.85em',
        lineHeight: 1,
        flex: '0 0 auto'
      }}
    >
      {g.glyph}
    </span>
  )
}
