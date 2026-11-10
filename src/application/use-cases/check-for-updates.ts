/**
 * Update checker. A small stateful object (not a command): it holds the last
 * known `UpdateStatus` and the release path of the newest candidate so the
 * install step can reuse it. `check()` is single-flight — concurrent callers
 * share one in-flight promise, so the (possibly slow) shared-dir listing runs once.
 */

import type { Clock } from '../../ports/clock'
import type { SettingsStore } from '../../ports/settings-store'
import type { UpdateSource } from '../../ports/update-source'
import {
  compareSemver,
  isNewer,
  parseReleaseDirName,
  parseSemver,
  type SemVer
} from '../../domain/semver'

/** Application-level mirror of the shared `UpdateStatusDTO` (main maps between them). */
export interface UpdateStatus {
  readonly state: 'upToDate' | 'available' | 'unreachable'
  /** Newest known newer release; kept while `unreachable`. */
  readonly availableVersion?: string
  readonly currentVersion: string
  /** Epoch ms of the last check; absent before the first check. */
  readonly lastCheckedAt?: number
  /** Version the user dismissed the popup for. */
  readonly dismissedVersion?: string
}

export interface CheckForUpdatesDeps {
  readonly source: UpdateSource
  readonly settings: Pick<SettingsStore, 'load' | 'save'>
  readonly clock: Clock
  readonly currentVersion: string
  /** Used when `settings.updates.dir` is unset or empty. */
  readonly defaultDir: string
  readonly timeoutMs: number
}

export interface UpdateChecker {
  check(): Promise<UpdateStatus>
  getStatus(): UpdateStatus
  /** Persist `updates.dismissedVersion` and reflect it in the status. */
  dismiss(version: string): UpdateStatus
  /** Release path for `version` if it is the newest candidate seen; else undefined. */
  releasePathFor(version: string): string | undefined
}

const formatSemver = (v: SemVer): string => `${v.major}.${v.minor}.${v.patch}`

/** Popup shows iff a release is available and newer than the dismissed one (if any). */
export function shouldPopup(status: UpdateStatus): boolean {
  if (status.state !== 'available' || status.availableVersion === undefined) {
    return false
  }
  const dismissed = status.dismissedVersion
  return dismissed === undefined || dismissed === '' || isNewer(status.availableVersion, dismissed)
}

export function createUpdateChecker(deps: CheckForUpdatesDeps): UpdateChecker {
  const dismissedOf = (): string | undefined => {
    const d = deps.settings.load().updates?.dismissedVersion
    // A malformed stored value (hand-edited settings) is treated as absent.
    return d === undefined || parseSemver(d) === null ? undefined : d
  }

  let status: UpdateStatus = {
    state: 'upToDate',
    currentVersion: deps.currentVersion,
    ...withDismissed(dismissedOf())
  }
  let candidate: { readonly version: string; readonly path: string } | undefined
  let inFlight: Promise<UpdateStatus> | undefined

  function withDismissed(d: string | undefined): { dismissedVersion?: string } {
    return d === undefined ? {} : { dismissedVersion: d }
  }

  async function run(): Promise<UpdateStatus> {
    const configured = deps.settings.load().updates?.dir
    const dir = configured !== undefined && configured !== '' ? configured : deps.defaultDir
    const result = await deps.source.listCandidates(dir, deps.timeoutMs)
    const lastCheckedAt = deps.clock.now()
    const dismissed = withDismissed(dismissedOf())

    if (result.kind === 'unreachable') {
      status = {
        state: 'unreachable',
        currentVersion: deps.currentVersion,
        lastCheckedAt,
        ...(status.availableVersion !== undefined
          ? { availableVersion: status.availableVersion }
          : {}),
        ...dismissed
      }
      return status
    }

    let best: { readonly ver: SemVer; readonly path: string } | undefined
    for (const c of result.candidates) {
      const ver = parseReleaseDirName(c.name)
      if (ver === null || !isNewer(formatSemver(ver), deps.currentVersion)) {
        continue
      }
      if (best === undefined || compareSemver(ver, best.ver) > 0) {
        best = { ver, path: c.path }
      }
    }

    if (best === undefined) {
      candidate = undefined
      status = {
        state: 'upToDate',
        currentVersion: deps.currentVersion,
        lastCheckedAt,
        ...dismissed
      }
    } else {
      const availableVersion = formatSemver(best.ver)
      candidate = { version: availableVersion, path: best.path }
      status = {
        state: 'available',
        availableVersion,
        currentVersion: deps.currentVersion,
        lastCheckedAt,
        ...dismissed
      }
    }
    return status
  }

  return {
    check() {
      inFlight ??= run().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    getStatus: () => status,
    dismiss(version) {
      deps.settings.save({ updates: { dismissedVersion: version } })
      status = { ...status, dismissedVersion: version }
      return status
    },
    releasePathFor: (version) => (candidate?.version === version ? candidate.path : undefined)
  }
}
