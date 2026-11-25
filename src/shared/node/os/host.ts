/**
 * The ONLY place that reads the host OS (`process.platform`). Process entry points
 * (main, preload, daemon, cli) call this once and pass the profile down. Uses only the
 * `process` global (no node imports), so the sandboxed preload can import it.
 */

import { osProfile, toOsId, type OsId, type OsProfile } from '../../os'

export function hostOs(): OsId {
  return toOsId(process.platform)
}

export function hostProfile(): OsProfile {
  return osProfile(hostOs())
}
