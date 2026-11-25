/**
 * State-detection debug overlay (DESIGN §11 observability). A keyboard-toggled
 * (`Ctrl+Shift+D`, `Cmd+Shift+D` on macOS, see `debugOverlayChord` in `shared/keybindings.ts`) floating
 * panel showing the last N session-state transitions this window has seen — the
 * newest at the top — with the deciding signal's LAYER and REASON (and confidence).
 * It is the on-screen twin of the `state.log` file (§11): the same
 * `sessionStateChanged` metadata, kept in a capped renderer ring, for tuning the §9.3
 * thresholds without tailing a file.
 *
 * Purely a projection of `store.debugTransitions`; it dispatches nothing and holds
 * no state of its own. Rendered in BOTH window roles (main + secondary) so a
 * detached session's transitions are inspectable where they happen.
 */

import { useStore } from '../store/store'
import { color, fontSize, font, radius, shadow, space } from '../style/tokens'

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  right: 12,
  width: 420,
  maxHeight: '70vh',
  display: 'flex',
  flexDirection: 'column',
  background: color.bgSurface,
  color: color.text,
  border: `1px solid ${color.borderStrong}`,
  borderRadius: radius.md,
  boxShadow: shadow.lg,
  fontFamily: font.mono,
  fontSize: fontSize.sm,
  zIndex: 200
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: `${space.x2} ${space.x3}`,
  borderBottom: `1px solid ${color.border}`,
  fontFamily: font.sans,
  color: color.textSecondary
}

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: space.x2,
  overflowY: 'auto',
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: space.x1
}

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  gap: space.x2,
  alignItems: 'baseline',
  padding: `2px ${space.x2}`,
  whiteSpace: 'nowrap'
}

/** Dim Medium/Low-confidence rows (§9.3) so noisy heuristic signals read as tentative. */
function confidenceOpacity(confidence?: string): number {
  return confidence === 'medium' || confidence === 'low' ? 0.6 : 1
}

/** Short `L<layer>` tag, or `L?` when the provider supplied no layer. */
function layerTag(layer?: 1 | 2 | 3): string {
  return layer ? `L${layer}` : 'L?'
}

export function DebugOverlay(): React.JSX.Element | null {
  const open = useStore((s) => s.debugOverlayOpen)
  const transitions = useStore((s) => s.debugTransitions)
  const toggle = useStore((s) => s.toggleDebugOverlay)
  if (!open) return null

  return (
    <aside style={panelStyle} aria-label="state detection debug overlay">
      <div style={headerStyle}>
        <span>State transitions ({transitions.length})</span>
        <button
          type="button"
          onClick={toggle}
          aria-label="close debug overlay"
          style={{
            background: 'transparent',
            border: 'none',
            color: color.muted,
            cursor: 'pointer',
            fontSize: fontSize.base
          }}
        >
          ✕
        </button>
      </div>
      {transitions.length === 0 ? (
        <p style={{ padding: space.x3, color: color.muted, fontFamily: font.sans }}>
          No transitions yet.
        </p>
      ) : (
        <ul style={listStyle}>
          {[...transitions].reverse().map((t) => (
            <li key={t.seq} style={{ ...rowStyle, opacity: confidenceOpacity(t.confidence) }}>
              <span style={{ color: color.accent }}>{layerTag(t.layer)}</span>
              <span>
                <span style={{ color: color.muted }}>{t.sessionId.slice(0, 8)} </span>
                {t.from} → <strong>{t.to}</strong>
              </span>
              <span style={{ color: color.muted }}>{t.reason ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
