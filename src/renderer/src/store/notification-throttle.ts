/**
 * A per-session leading-edge throttle for the §9.5 status-change toast, living in the
 * RENDERER next to the focus-suppression check (`isSessionFocused`). It exists here — not
 * in main — so the cooldown window is anchored to the toast the user ACTUALLY SAW: main
 * cannot know whether a notification was shown, because whether to suppress it (the user
 * is already looking at the session) is a per-window decision only the renderer can make.
 * Throttling in main armed the window on every emit ATTEMPT, so a focus-suppressed
 * `waiting → working` (you hit Enter while watching the session) started a cooldown that
 * then swallowed the `working → waiting` "it finished" toast you wanted after switching
 * away — the "I don't always see the toast" symptom.
 *
 * `admit(sessionId)` is the gate: it returns `true` (and arms a cooldown) when the session
 * is cold — the caller then shows the toast — and `false` while the session is hot, so the
 * caller drops it WITHOUT re-arming. A rejected `admit` never touches the timer, so the
 * window measures `windowMs` since the last SHOWN toast. This absorbs Claude's
 * `working → waiting → blocked` turn-end burst into one toast regardless of the gap
 * between its hooks.
 *
 * The store calls `admit` ONLY after `isSessionFocused` says the toast would be shown, so a
 * suppressed change never consumes the window. Each window has its own store instance, so
 * the throttle is naturally per-window. Timers are injectable so it unit-tests without a
 * wall clock, mirroring the injected-timer style elsewhere in the codebase.
 */

export interface NotificationThrottle {
  /**
   * Gate one would-be-shown change. Returns `true` and arms the cooldown when the session
   * is cold (caller shows the toast); returns `false` while hot (caller drops it, and the
   * window is NOT extended — it stays anchored to the last shown toast).
   */
  admit(sessionId: string): boolean
  /** Clear pending timers; leaves nothing scheduled. */
  dispose(): void
}

export interface NotificationThrottleOptions {
  /**
   * How long (ms) a session stays "hot" (suppressing further toasts) after one is shown.
   * Long enough to swallow Claude's `Stop` → `Notification` two-write burst (whose gap
   * exceeds a few hundred ms in practice); short enough that a genuinely new change soon
   * after still surfaces. Default 6000.
   */
  readonly windowMs?: number
  /** Timer injection for tests; defaults to setTimeout/clearTimeout. */
  readonly timers?: {
    setTimer(fn: () => void, ms: number): unknown
    clearTimer(handle: unknown): void
  }
}

const DEFAULT_TIMERS = {
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/**
 * Create a per-session leading-edge notification throttle. The first `admit` for a cold
 * session returns `true` and arms a `windowMs` cooldown; subsequent `admit`s for that
 * session within the window return `false` without re-arming, so the window is anchored to
 * the last SHOWN toast.
 */
export function createNotificationThrottle(
  opts: NotificationThrottleOptions = {}
): NotificationThrottle {
  const timers = opts.timers ?? DEFAULT_TIMERS
  const windowMs = opts.windowMs ?? 6000
  // sessionId → the cooldown timer handle. Presence means "hot" (reject).
  const hot = new Map<string, unknown>()

  return {
    admit: (sessionId): boolean => {
      if (hot.has(sessionId)) {
        return false // still within the cooldown of the last shown toast — drop.
      }
      const timer = timers.setTimer(() => {
        hot.delete(sessionId)
      }, windowMs)
      hot.set(sessionId, timer)
      return true
    },
    dispose: (): void => {
      for (const timer of hot.values()) {
        timers.clearTimer(timer)
      }
      hot.clear()
    }
  }
}
