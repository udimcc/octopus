/**
 * The one place the Claude wire-state string is mapped to the domain
 * {@link SessionState} (DESIGN §9). Extracted into its own module so BOTH the
 * file-watch source edge ({@link ClaudeStateWatcher}) and any legacy adapter share
 * a single mapper — and so it survives the removal of the old socket/composite
 * pipeline. The enum VALUES equal the wire strings, so this is a pure re-label that
 * also narrows an untrusted string to the enum (unknown for anything unexpected).
 */

import { SessionState } from '../../domain/state'

/** The four state strings the Claude bridge ever emits (equal to the enum values). */
export type ClaudeStateString = 'unknown' | 'waiting' | 'working' | 'blocked'

/** Map a Claude wire-state string to the domain enum; unknown for anything else. */
export function coreToSessionState(state: string): SessionState {
  switch (state) {
    case 'waiting':
      return SessionState.Idle
    case 'working':
      return SessionState.Working
    case 'blocked':
      return SessionState.NeedsInput
    default:
      return SessionState.Unknown
  }
}
