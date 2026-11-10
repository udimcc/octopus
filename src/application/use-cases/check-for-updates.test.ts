import { describe, it, expect, vi } from 'vitest'
import { createUpdateChecker, shouldPopup, type UpdateStatus } from './check-for-updates'
import { FakeSettingsStore, FakeClock } from './test-fakes'
import type { UpdateSource, ListCandidatesResult } from '../../ports/update-source'
import type { Settings } from '../../ports/settings-store'

function makeSource(results: ListCandidatesResult[]) {
  const queue = [...results]
  const listCandidates = vi.fn(
    async (dir: string, timeoutMs: number): Promise<ListCandidatesResult> => {
      void dir
      void timeoutMs
      return queue.shift() ?? { kind: 'ok', candidates: [] }
    }
  )
  const source: UpdateSource = {
    listCandidates,
    stageToTemp: vi.fn(),
    cleanup: vi.fn()
  }
  return { source, listCandidates }
}

const ok = (...names: string[]): ListCandidatesResult => ({
  kind: 'ok',
  candidates: names.map((n) => ({ name: n, path: `/r/${n}` }))
})

function setup(
  results: ListCandidatesResult[],
  opts: { current?: string; updates?: Settings['updates'] } = {}
) {
  const base = new FakeSettingsStore()
  const settings = new FakeSettingsStore({ ...base.load(), updates: opts.updates })
  const clock = new FakeClock(5000)
  const { source, listCandidates } = makeSource(results)
  const checker = createUpdateChecker({
    source,
    settings,
    clock,
    currentVersion: opts.current ?? '1.0.0',
    defaultDir: '/default',
    timeoutMs: 123
  })
  return { checker, settings, listCandidates, clock }
}

describe('createUpdateChecker', () => {
  it('starts upToDate with no lastCheckedAt', () => {
    const { checker } = setup([])
    expect(checker.getStatus()).toEqual({ state: 'upToDate', currentVersion: '1.0.0' })
  })

  it('picks the highest strictly-newer valid release and records the check time', async () => {
    const { checker, listCandidates } = setup([
      ok(
        'octopus-1.9.0',
        'octopus-1.10.0',
        'octopus-1.0.0',
        'octopus-0.5.0',
        'octopus-2.0',
        'foo-9.0.0'
      )
    ])
    const st = await checker.check()
    expect(st).toMatchObject({
      state: 'available',
      availableVersion: '1.10.0',
      lastCheckedAt: 5000
    })
    expect(listCandidates).toHaveBeenCalledWith('/default', 123)
    expect(checker.releasePathFor('1.10.0')).toBe('/r/octopus-1.10.0')
    expect(checker.releasePathFor('1.9.0')).toBeUndefined()
  })

  it('equal/older/malformed only -> upToDate and clears the candidate', async () => {
    const { checker } = setup([ok('octopus-1.1.0'), ok('octopus-1.0.0', 'octopus-1.2.0-rc1')])
    await checker.check()
    expect(checker.releasePathFor('1.1.0')).toBe('/r/octopus-1.1.0')
    const st = await checker.check()
    expect(st.state).toBe('upToDate')
    expect(st.availableVersion).toBeUndefined()
    expect(checker.releasePathFor('1.1.0')).toBeUndefined()
  })

  it('uses settings updates.dir when set, default when empty', async () => {
    const a = setup([ok()], { updates: { dir: '/custom' } })
    await a.checker.check()
    expect(a.listCandidates).toHaveBeenCalledWith('/custom', 123)
    const b = setup([ok()], { updates: { dir: '' } })
    await b.checker.check()
    expect(b.listCandidates).toHaveBeenCalledWith('/default', 123)
  })

  it('unreachable keeps the previous availableVersion (and release path)', async () => {
    const { checker } = setup([ok('octopus-1.5.0'), { kind: 'unreachable', reason: 'x' }])
    await checker.check()
    const st = await checker.check()
    expect(st).toMatchObject({ state: 'unreachable', availableVersion: '1.5.0' })
    expect(checker.releasePathFor('1.5.0')).toBe('/r/octopus-1.5.0')
  })

  it('unreachable with nothing known has no availableVersion', async () => {
    const { checker } = setup([{ kind: 'unreachable', reason: 'x' }])
    const st = await checker.check()
    expect(st.state).toBe('unreachable')
    expect('availableVersion' in st).toBe(false)
  })

  it('is single-flight: concurrent checks share one listing', async () => {
    const { checker, listCandidates } = setup([ok('octopus-1.1.0')])
    const [a, b] = await Promise.all([checker.check(), checker.check()])
    expect(a).toBe(b)
    expect(listCandidates).toHaveBeenCalledTimes(1)
    await checker.check()
    expect(listCandidates).toHaveBeenCalledTimes(2)
  })

  it('dismiss persists and is reflected in the status', async () => {
    const { checker, settings } = setup([ok('octopus-1.1.0')])
    await checker.check()
    const st = checker.dismiss('1.1.0')
    expect(st.dismissedVersion).toBe('1.1.0')
    expect(settings.load().updates?.dismissedVersion).toBe('1.1.0')
    expect(checker.getStatus().dismissedVersion).toBe('1.1.0')
  })

  it('reads a persisted dismissedVersion at construction and across checks', async () => {
    const { checker } = setup([ok('octopus-1.1.0')], { updates: { dismissedVersion: '1.1.0' } })
    expect(checker.getStatus().dismissedVersion).toBe('1.1.0')
    expect((await checker.check()).dismissedVersion).toBe('1.1.0')
  })

  it.each(['garbage', '1.2', 'v1.2.3', ''])(
    'treats malformed dismissedVersion %j as absent',
    async (d) => {
      const { checker } = setup([ok('octopus-1.1.0')], { updates: { dismissedVersion: d } })
      expect(checker.getStatus().dismissedVersion).toBeUndefined()
      const st = await checker.check()
      expect(st.dismissedVersion).toBeUndefined()
      expect(shouldPopup(st)).toBe(true)
    }
  )
})

describe('shouldPopup', () => {
  const avail = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
    state: 'available',
    availableVersion: '1.2.0',
    currentVersion: '1.0.0',
    ...over
  })

  it('true when available and nothing dismissed', () => {
    expect(shouldPopup(avail())).toBe(true)
  })
  it('false when the available version equals or is below the dismissed one', () => {
    expect(shouldPopup(avail({ dismissedVersion: '1.2.0' }))).toBe(false)
    expect(shouldPopup(avail({ dismissedVersion: '1.3.0' }))).toBe(false)
  })
  it('true again when a newer release than the dismissed one appears', () => {
    expect(shouldPopup(avail({ dismissedVersion: '1.1.0' }))).toBe(true)
    expect(shouldPopup(avail({ availableVersion: '1.10.0', dismissedVersion: '1.9.0' }))).toBe(true)
  })
  it('treats empty dismissedVersion as absent', () => {
    expect(shouldPopup(avail({ dismissedVersion: '' }))).toBe(true)
  })
  it('false for upToDate, unreachable, or a missing availableVersion', () => {
    expect(shouldPopup({ state: 'upToDate', currentVersion: '1.0.0' })).toBe(false)
    expect(shouldPopup(avail({ state: 'unreachable' }))).toBe(false)
    expect(shouldPopup(avail({ availableVersion: undefined }))).toBe(false)
  })
})
