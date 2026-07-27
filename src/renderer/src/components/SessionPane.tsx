/**
 * One session pane, kept mounted and toggled visible/hidden (DESIGN §5.3).
 * Extracted verbatim from the M5 inline `App.tsx`. The pane resolves its view
 * component from the session's `typeId` (`resolveSessionView`) so V3's Jenkins
 * view slots in without touching this file.
 *
 * Visibility, not mounting, is what toggles here: an inactive pane stays in the
 * DOM at `visibility:hidden` so its terminal keeps its scrollback and WebGL
 * context alive (§5.3). Never swap this for conditional mounting.
 */

import { resolveSessionView } from '../session-views/session-view-factory'
import type { SessionDTO } from '../../../shared/dto'

export interface SessionPaneProps {
  readonly session: SessionDTO
  readonly active: boolean
}

export function SessionPane({ session, active }: SessionPaneProps): React.JSX.Element {
  const View = resolveSessionView(session.typeId)
  const style: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    visibility: active ? 'visible' : 'hidden'
  }
  return (
    <div style={style}>
      {View ? (
        <View sessionId={session.id} active={active} />
      ) : (
        <p>Unsupported: {session.typeId}</p>
      )}
    </div>
  )
}
