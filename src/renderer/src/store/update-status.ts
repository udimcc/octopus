/**
 * Pure helpers over the self-update status (check-for-updates design). Kept apart from
 * store.ts like notification-throttle.ts.
 */
import type { UpdateStatusDTO, WindowRole } from '../../../shared/dto'

/** Whether the "update available" popup shows: main window only, main says `popup`, and not snoozed ("Not now"). */
export function showUpdatePopup(
  status: UpdateStatusDTO | null,
  windowRole: WindowRole,
  snoozedVersion: string | null = null
): boolean {
  return (
    windowRole === 'main' &&
    status !== null &&
    status.popup &&
    !!status.availableVersion &&
    status.availableVersion !== snoozedVersion
  )
}

/** Badge selector: an update is known (also when the last check was unreachable but stale-available). */
export function hasUpdateAvailable(status: UpdateStatusDTO | null): boolean {
  if (!status || status.availableVersion === undefined) return false
  return status.state === 'available' || status.state === 'unreachable'
}
