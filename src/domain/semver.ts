/**
 * Strict `X.Y.Z` release-version helpers for the update check. Pure — imports
 * nothing. Deliberately narrow: no `v` prefix, no prerelease/build suffix, no
 * partial versions; anything else is "not a release" (null), never guessed at.
 */

export interface SemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const RELEASE_DIR_PREFIX = 'octopus-'

/** Parse a strict `X.Y.Z` string; null when malformed or a component is unsafe. */
export function parseSemver(text: string): SemVer | null {
  const m = SEMVER_RE.exec(text)
  if (m === null) {
    return null
  }
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null
  }
  return { major, minor, patch }
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** True iff `candidate` is STRICTLY greater than `current`; false if either is malformed. */
export function isNewer(candidate: string, current: string): boolean {
  const c = parseSemver(candidate)
  const cur = parseSemver(current)
  return c !== null && cur !== null && compareSemver(c, cur) > 0
}

/**
 * Parse a release directory name `octopus-X.Y.Z` into its version; null for
 * anything else (`octopus-1.2`, `octopus-v1.2.0`, `octopus-1.2.0-rc1`, `foo-1.2.0`, '').
 */
export function parseReleaseDirName(name: string): SemVer | null {
  return name.startsWith(RELEASE_DIR_PREFIX)
    ? parseSemver(name.slice(RELEASE_DIR_PREFIX.length))
    : null
}
