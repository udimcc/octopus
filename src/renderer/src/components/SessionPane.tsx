/**
 * One session pane, kept mounted and toggled visible/hidden (DESIGN §5.3, §5.7).
 * Extracted verbatim from the M5 inline `App.tsx`; split panes add `rect` (and the
 * `focused`/`visible` split, mirroring `TerminalPane`'s own split of `active`).
 *
 * `rect` is this pane's absolute percentage box as a leaf of its SHOWN group's
 * layout tree (DESIGN §5.7, split-groups design); `undefined` means lone (no
 * group shown for this pane, or a group with fewer than 2 leaves hosted here) —
 * the pane fills the whole `pane-area` exactly as before. `TaskView` always
 * renders every hosted session as a flat sibling keyed by session id; only props
 * change here as groups are joined/left/ungrouped, resized, or closed (§5.3
 * keep-alive) — never wrap a pane in a per-group container.
 *
 * Visibility, not mounting, is what toggles here: a non-visible pane stays in the
 * DOM at `visibility:hidden` so its terminal keeps its scrollback and WebGL
 * context alive (§5.3). Never swap this for conditional mounting.
 */

import { resolveSessionView } from '../session-views/session-view-factory'
import { useStore } from '../store/store'
import { color } from '../style/tokens'
import type { PaneRect } from '../store/split-layout'
import type { SessionDTO } from '../../../shared/dto'

export interface SessionPaneProps {
  readonly session: SessionDTO
  /** On screen (§5.3): drives the view's fit/resize and renderer tier. */
  readonly visible: boolean
  /** Has keyboard focus (§3.7's mark — the one pane `term.focus()`-ed). */
  readonly focused: boolean
  /**
   * This pane's box as a leaf of its SHOWN group's layout tree (DESIGN §5.7); absent
   * means this session isn't part of a currently-shown group — a lone mark, a hidden
   * (non-member) tab, or a group transiently not drawn (fewer than 2 of its leaves
   * hosted here mid group-move, §7) — in any of those cases the pane fills the whole
   * `pane-area` exactly as an unsplit one would.
   */
  readonly rect?: PaneRect
}

/** Gap, in px, left around a split leaf's box for the divider gutter / focus outline. */
const SPLIT_GAP_PX = 2

export function SessionPane({
  session,
  visible,
  focused,
  rect
}: SessionPaneProps): React.JSX.Element {
  const View = resolveSessionView(session.typeId)
  const focusPane = useStore((s) => s.focusPane)
  const split = rect !== undefined

  const style: React.CSSProperties = rect
    ? {
        position: 'absolute',
        left: `calc(${rect.left}% + ${SPLIT_GAP_PX}px)`,
        top: `calc(${rect.top}% + ${SPLIT_GAP_PX}px)`,
        width: `calc(${rect.width}% - ${2 * SPLIT_GAP_PX}px)`,
        height: `calc(${rect.height}% - ${2 * SPLIT_GAP_PX}px)`,
        visibility: visible ? 'visible' : 'hidden',
        // An outline, not a border: it never changes the box, so toggling focus can't
        // refit the terminal. Not an inset box-shadow either — that paints beneath the
        // children, where the terminal's opaque surface would hide it. At offset 0 the
        // outline lands exactly in the SPLIT_GAP_PX gap around the pane.
        outline: focused ? `${SPLIT_GAP_PX}px solid ${color.accent}` : undefined
      }
    : {
        position: 'absolute',
        inset: 0,
        visibility: visible ? 'visible' : 'hidden'
      }

  // A click anywhere in a split pane that isn't focused moves focus there — but
  // never intercept the event: xterm still needs it for text selection and mouse
  // reporting. Nothing else to send from here: once the mark moves, `App`'s
  // `usePersistFocusedSession` persists it (`sessions.focus`) and
  // `useMarkVisibleSessionSeen` clears + relays its ready-for-review flag (§9.5).
  const onMouseDownCapture = split && !focused ? (): void => focusPane(session.id) : undefined

  return (
    <div style={style} onMouseDownCapture={onMouseDownCapture}>
      {View ? (
        <View sessionId={session.id} visible={visible} focused={focused} />
      ) : (
        <p>Unsupported: {session.typeId}</p>
      )}
    </div>
  )
}
