/**
 * Update scheduler (check-for-updates). Owns WHEN the checker runs (at boot, then
 * hourly, or on demand) and pushes the status to every window, but only when it
 * actually changed. Timers and the broadcast are injected so it is testable with
 * fake timers; it never imports Electron.
 */

import {
  shouldPopup,
  type UpdateChecker,
  type UpdateStatus
} from '../application/use-cases/check-for-updates'
import type { UpdateStatusDTO } from '../shared/dto'
import type { UpdateStatusChangedEventDTO } from '../shared/events'

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export interface UpdateSchedulerDeps {
  readonly checker: UpdateChecker
  readonly broadcast: (event: UpdateStatusChangedEventDTO) => void
  readonly intervalMs?: number
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface UpdateScheduler {
  /** Check now, then every interval. Idempotent. */
  start(): void
  stop(): void
  /** Run (or join) a check and broadcast if the status changed. */
  checkNow(): Promise<UpdateStatusDTO>
  /** Broadcast the checker's current status if it differs from the last broadcast. */
  publish(): UpdateStatusDTO
}

function sameStatus(a: UpdateStatus, b: UpdateStatus): boolean {
  return (
    a.state === b.state &&
    a.availableVersion === b.availableVersion &&
    a.currentVersion === b.currentVersion &&
    a.lastCheckedAt === b.lastCheckedAt &&
    a.dismissedVersion === b.dismissedVersion
  )
}

/** Map the checker's status to the wire DTO (adds the popup verdict). */
export function toStatusDTO(status: UpdateStatus): UpdateStatusDTO {
  return { ...status, popup: shouldPopup(status) }
}

export function createUpdateScheduler(deps: UpdateSchedulerDeps): UpdateScheduler {
  const intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  const setTimer =
    deps.setInterval ??
    ((fn: () => void, ms: number): unknown => {
      const h = setInterval(fn, ms)
      h.unref() // never keep the process alive just for update checks
      return h
    })
  const clearTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout))

  // Windows hydrate via getStatus(), so the baseline is whatever the checker holds now.
  let lastSent: UpdateStatus = deps.checker.getStatus()
  let timer: unknown
  let inFlight: Promise<UpdateStatusDTO> | undefined

  const publish = (): UpdateStatusDTO => {
    const status = deps.checker.getStatus()
    const dto = toStatusDTO(status)
    if (!sameStatus(status, lastSent)) {
      lastSent = status
      deps.broadcast({ type: 'updateStatusChanged', status: dto })
    }
    return dto
  }

  const checkNow = (): Promise<UpdateStatusDTO> => {
    inFlight ??= deps.checker
      .check()
      .then(publish)
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  const tick = (): void => {
    if (inFlight !== undefined) {
      return
    }
    checkNow().catch((err) => console.error('[octopus] update check failed:', err))
  }

  return {
    start() {
      if (timer !== undefined) {
        return
      }
      tick()
      timer = setTimer(tick, intervalMs)
    },
    stop() {
      if (timer !== undefined) {
        clearTimer(timer)
        timer = undefined
      }
    },
    checkNow,
    publish
  }
}
