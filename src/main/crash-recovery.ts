/**
 * Renderer-crash policy (DESIGN §6.7).
 *
 * A renderer process can die without any JavaScript error — Chromium aborts it on a fatal
 * condition (e.g. memory exhaustion in Blink's heap, which is what a runaway per-frame
 * stylesheet rebuild across every keep-alive terminal pane did: `reason: 'crashed'`,
 * `exitCode: 133` = SIGTRAP). Electron does **not** respawn it, and `webContents.isDestroyed()`
 * stays FALSE afterwards, so nothing in the app noticed: the `WindowRegistry` kept sending
 * events into a dead process and the user was left staring at a permanently white window
 * with no log line to explain it.
 *
 * So a crash must be (a) logged and (b) recovered from — but bounded, because a
 * deterministic crash would otherwise reload forever. This module is the pure decision;
 * `wireCrashRecovery` in `window.ts` owns the effects (log, re-register, reload, dialog),
 * following the same pure-resolver / effectful-wrapper split as `paths.ts` (§6.3).
 */

/** What to do about a renderer that just died. */
export type CrashAction = 'reload' | 'ask-user'

/**
 * Auto-reloads allowed per burst. Two: one for a transient crash, a second for a crash
 * that the reload itself provoked, then we stop and let the user decide.
 */
export const MAX_AUTO_RELOADS = 2

/**
 * A crash this long after the previous one starts a fresh burst. Anything faster is a
 * crash loop (the recorded failure died ~12 s after load, so the window must be far
 * wider than one reload cycle for the counter to mean anything).
 */
export const CRASH_BURST_WINDOW_MS = 60_000

/**
 * Decide what to do when a renderer process goes away.
 *
 * - `'clean-exit'` is never auto-reloaded: the renderer exited on purpose (teardown,
 *   navigation, quit), so reloading would fight the app instead of healing it.
 * - An isolated crash (nothing recent to compare with) always gets a reload.
 * - Inside a burst, reload up to `MAX_AUTO_RELOADS` times, then hand it to the user.
 *
 * `attemptsInBurst` counts reloads already issued in the current burst; `msSinceLast` is
 * the gap since the previous crash (`Number.POSITIVE_INFINITY` for the first one).
 */
export function decideCrashRecovery(
  reason: string,
  attemptsInBurst: number,
  msSinceLast: number
): CrashAction {
  if (reason === 'clean-exit') {
    return 'ask-user'
  }
  if (msSinceLast > CRASH_BURST_WINDOW_MS) {
    return 'reload'
  }
  return attemptsInBurst < MAX_AUTO_RELOADS ? 'reload' : 'ask-user'
}
