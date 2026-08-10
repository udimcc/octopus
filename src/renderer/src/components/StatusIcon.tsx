/**
 * The session/task status icon (DESIGN §5.4, §3.3, §9). Purely presentational: it
 * maps ONE resolved {@link DisplayState} to a glyph/color/label. All precedence —
 * the state lattice AND the ready-for-review flag (§9.5) — is folded upstream in the
 * store (`sessionDisplayState`/`taskDisplayState`), so this file owns only the glyph
 * mapping (one source of truth for both the session-tab and task-list variants).
 *
 * The product's UI vocabulary (§3.3, §9.5): **Needs input** (`blocked`), **Ready for
 * review** (a just-finished, unseen session), **Working**, **Idle** (`waiting`).
 * `none` (unknown / no signal) renders nothing so an un-evaluated session never masks
 * a more urgent one.
 *
 * `working` gently pulses ("in progress"); `review` is the SAME accent dot but static
 * — the pulse is the only thing distinguishing "still running" from "done, wants your
 * eyes". Because the display level is gated in the store (review is valid only while
 * idle), a running session can never render the static review dot.
 *
 * No icon library — glyphs are inline text so they cost nothing and render identically
 * under SwiftShader (no GPU, per project notes).
 */

import { color } from '../style/tokens'
import type { DisplayState } from '../store/display-state'

interface Glyph {
  readonly glyph: string
  readonly color: string
  readonly label: string
  /** A subtle pulse conveys "in progress"; static states don't animate. */
  readonly pulse?: boolean
}

/** Display level → glyph/color/label. `none` is absent (renders nothing). */
const GLYPHS: Readonly<Record<Exclude<DisplayState, 'none'>, Glyph>> = {
  // ▲ warning — a permission/attention request, or an exited/failed session (§3.4 I12).
  needsInput: { glyph: '▲', color: color.errorText, label: 'Needs input' },
  // ● teal, static — just finished while unfocused; "wants your eyes" (§9.5).
  review: { glyph: '●', color: color.accent, label: 'Ready for review' },
  // ● blue, gently pulsing — Claude thinking / a foreground command running.
  working: { glyph: '●', color: color.statusWorking, label: 'Working', pulse: true },
  // ○ muted hollow — at a prompt / turn finished (the product's "Idle").
  idle: { glyph: '○', color: color.muted, label: 'Idle' }
}

export interface StatusIconProps {
  /** The resolved display level (from `sessionDisplayState`/`taskDisplayState`). */
  readonly display: DisplayState
  /** px; the glyph scales with the surrounding text by default. */
  readonly size?: number
}

export function StatusIcon({ display, size }: StatusIconProps): React.JSX.Element | null {
  if (display === 'none') return null
  const g = GLYPHS[display]
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
