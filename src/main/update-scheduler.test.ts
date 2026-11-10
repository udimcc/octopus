import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createUpdateScheduler, toStatusDTO, UPDATE_CHECK_INTERVAL_MS } from './update-scheduler'
import type { UpdateChecker, UpdateStatus } from '../application/use-cases/check-for-updates'

const base: UpdateStatus = { state: 'upToDate', currentVersion: '1.0.0' }

function fakeChecker(initial: UpdateStatus = base) {
  let status = initial
  const pending: Array<(s: UpdateStatus) => void> = []
  const checker: UpdateChecker = {
    getStatus: () => status,
    check: vi.fn(
      () =>
        new Promise<UpdateStatus>((resolve) => {
          pending.push((next) => {
            status = next
            resolve(next)
          })
        })
    ),
    dismiss: vi.fn((v: string) => {
      status = { ...status, dismissedVersion: v }
      return status
    }),
    releasePathFor: vi.fn()
  }
  return {
    checker,
    finish: (s: UpdateStatus) => pending.shift()!(s),
    setStatus: (s: UpdateStatus) => (status = s)
  }
}

describe('toStatusDTO', () => {
  it('adds the popup verdict', () => {
    const avail: UpdateStatus = {
      state: 'available',
      availableVersion: '1.1.0',
      currentVersion: '1.0.0'
    }
    expect(toStatusDTO(avail).popup).toBe(true)
    expect(toStatusDTO({ ...avail, dismissedVersion: '1.1.0' }).popup).toBe(false)
    expect(toStatusDTO(base).popup).toBe(false)
  })
})

describe('createUpdateScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('checks at start, then every hour, and broadcasts after each completed check', async () => {
    const { checker, finish } = fakeChecker()
    const broadcast = vi.fn()
    const s = createUpdateScheduler({ checker, broadcast })
    s.start()
    expect(checker.check).toHaveBeenCalledTimes(1)
    finish({ ...base, lastCheckedAt: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'updateStatusChanged',
      status: { state: 'upToDate', popup: false, lastCheckedAt: 1 }
    })

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(checker.check).toHaveBeenCalledTimes(2)
    finish({ ...base, lastCheckedAt: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(broadcast).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('does not broadcast when the status is unchanged', async () => {
    const { checker, finish } = fakeChecker()
    const broadcast = vi.fn()
    const s = createUpdateScheduler({ checker, broadcast })
    s.start()
    finish({ ...base })
    await vi.advanceTimersByTimeAsync(0)
    expect(broadcast).not.toHaveBeenCalled()
    s.stop()
  })

  it('does not overlap: a tick during an in-flight check is skipped', async () => {
    const { checker, finish } = fakeChecker()
    const s = createUpdateScheduler({ checker, broadcast: vi.fn(), intervalMs: 100 })
    s.start()
    await vi.advanceTimersByTimeAsync(350)
    expect(checker.check).toHaveBeenCalledTimes(1)
    finish({ ...base, lastCheckedAt: 1 })
    await vi.advanceTimersByTimeAsync(100)
    expect(checker.check).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('checkNow joins an in-flight check', async () => {
    const { checker, finish } = fakeChecker()
    const s = createUpdateScheduler({ checker, broadcast: vi.fn() })
    const a = s.checkNow()
    const b = s.checkNow()
    expect(checker.check).toHaveBeenCalledTimes(1)
    finish({ ...base, lastCheckedAt: 9 })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual(rb)
    expect(ra.lastCheckedAt).toBe(9)
  })

  it('start is idempotent and stop halts the interval', async () => {
    const { checker, finish } = fakeChecker()
    const s = createUpdateScheduler({ checker, broadcast: vi.fn(), intervalMs: 100 })
    s.start()
    s.start()
    expect(checker.check).toHaveBeenCalledTimes(1)
    finish({ ...base, lastCheckedAt: 1 })
    await vi.advanceTimersByTimeAsync(0)
    s.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(checker.check).toHaveBeenCalledTimes(1)
  })

  it('uses injected timer functions', () => {
    const { checker } = fakeChecker()
    const setI = vi.fn(() => 'h')
    const clearI = vi.fn()
    const s = createUpdateScheduler({
      checker,
      broadcast: vi.fn(),
      intervalMs: 5,
      setInterval: setI,
      clearInterval: clearI
    })
    s.start()
    expect(setI).toHaveBeenCalledWith(expect.any(Function), 5)
    s.stop()
    expect(clearI).toHaveBeenCalledWith('h')
  })

  it('publish broadcasts a dismiss-driven change once, then not again', () => {
    const { checker, setStatus } = fakeChecker()
    const broadcast = vi.fn()
    const s = createUpdateScheduler({ checker, broadcast })
    setStatus({ state: 'available', availableVersion: '1.1.0', currentVersion: '1.0.0' })
    expect(s.publish().popup).toBe(true)
    expect(broadcast).toHaveBeenCalledTimes(1)
    s.publish()
    expect(broadcast).toHaveBeenCalledTimes(1)
    checker.dismiss('1.1.0')
    const dto = s.publish()
    expect(dto.popup).toBe(false)
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(broadcast.mock.calls[1][0].status.popup).toBe(false)
  })

  it('a failing check is logged and does not stop later ticks', async () => {
    const { checker } = fakeChecker()
    vi.mocked(checker.check).mockRejectedValueOnce(new Error('bad'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = createUpdateScheduler({ checker, broadcast: vi.fn(), intervalMs: 100 })
    s.start()
    await vi.advanceTimersByTimeAsync(150)
    expect(err).toHaveBeenCalled()
    expect(checker.check).toHaveBeenCalledTimes(2)
    s.stop()
    err.mockRestore()
  })
})
