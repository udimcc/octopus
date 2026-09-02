import { describe, it, expect } from 'vitest'
import { decideCrashRecovery, CRASH_BURST_WINDOW_MS, MAX_AUTO_RELOADS } from './crash-recovery'

describe('decideCrashRecovery (§6.7)', () => {
  it('reloads the first crash of a run', () => {
    // No previous crash → the gap is infinite.
    expect(decideCrashRecovery('crashed', 0, Number.POSITIVE_INFINITY)).toBe('reload')
  })

  it('reloads up to MAX_AUTO_RELOADS times inside a burst, then asks the user', () => {
    const soon = 1_000
    expect(decideCrashRecovery('crashed', 0, soon)).toBe('reload')
    expect(decideCrashRecovery('crashed', 1, soon)).toBe('reload')
    // Third crash in the same burst: reloading again is a loop, not a recovery.
    expect(decideCrashRecovery('crashed', MAX_AUTO_RELOADS, soon)).toBe('ask-user')
    expect(decideCrashRecovery('crashed', MAX_AUTO_RELOADS + 5, soon)).toBe('ask-user')
  })

  it('a crash long after the previous one starts a fresh burst', () => {
    // A window that ran fine for hours and then died once must self-heal, however many
    // times it crashed in some earlier burst.
    expect(decideCrashRecovery('crashed', 99, CRASH_BURST_WINDOW_MS + 1)).toBe('reload')
    // Exactly at the boundary is still the same burst (the comparison is strict).
    expect(decideCrashRecovery('crashed', MAX_AUTO_RELOADS, CRASH_BURST_WINDOW_MS)).toBe('ask-user')
  })

  it('never auto-reloads a clean exit — the renderer went away on purpose', () => {
    expect(decideCrashRecovery('clean-exit', 0, Number.POSITIVE_INFINITY)).toBe('ask-user')
  })

  it('treats every other Chromium reason as a crash worth reloading', () => {
    // `reason` comes from Electron's RenderProcessGoneDetails; the OOM/kill variants are
    // exactly the cases the white-window bug produced (`crashed`, exitCode 133).
    for (const reason of ['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed']) {
      expect(decideCrashRecovery(reason, 0, Number.POSITIVE_INFINITY)).toBe('reload')
    }
  })
})
