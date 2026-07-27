/**
 * Resolve a session's UI component from its `typeId` (DESIGN §8, §10 seam). V1
 * knows only `terminal`; V3 adds `jenkins` to this map with no change to callers.
 * Keying on `typeId` (not a hard-coded `<TerminalPane>`) is the dormant seam that
 * keeps the renderer's pane area additive across versions.
 */

import type { ComponentType } from 'react'
import { TerminalPane, type TerminalPaneProps } from '../terminal/TerminalPane'

/** Props every session view receives from the pane area. */
export type SessionViewProps = TerminalPaneProps

const VIEWS: Record<string, ComponentType<SessionViewProps>> = {
  terminal: TerminalPane
}

/** The component for a session type, or `undefined` if this version has no view. */
export function resolveSessionView(typeId: string): ComponentType<SessionViewProps> | undefined {
  return VIEWS[typeId]
}
