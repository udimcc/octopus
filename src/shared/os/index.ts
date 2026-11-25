/** The OS layer's entry point (see `profile.ts` and `.claude/rules/os-layer.md`). */

import { darwin } from './darwin'
import { linux } from './linux'
import type { OsId, OsProfile } from './profile'
import { win32 } from './win32'

export * from './profile'

/** Every supported OS's profile. Adding an `OsId` does not compile until its profile exists. */
export const PROFILES: Readonly<Record<OsId, OsProfile>> = Object.freeze({ linux, darwin, win32 })

export function osProfile(id: OsId): OsProfile {
  return PROFILES[id]
}

/** Map a `process.platform`-style id to an `OsId`; anything unknown is treated as Linux. */
export function toOsId(raw: string): OsId {
  return raw === 'darwin' ? 'darwin' : raw === 'win32' ? 'win32' : 'linux'
}
