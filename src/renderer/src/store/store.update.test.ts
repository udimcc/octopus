import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useStore, initialData, reduceEvent } from './store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { UpdateStatusDTO, WindowedWorkspaceStateDTO } from '../../../shared/dto'

const status = (over: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO => ({
  state: 'available',
  availableVersion: '1.2.0',
  currentVersion: '1.0.0',
  popup: true,
  ...over
})

const wsState: WindowedWorkspaceStateDTO = {
  tasks: [],
  activeTaskId: undefined,
  sessionTypes: [],
  issues: [],
  settings: {
    worktree: { location: '' },
    terminal: {},
    defaultSessionTypeId: 'terminal',
    groupTasksByRepo: true
  },
  version: 1,
  thisWindowId: 'main',
  thisWindowRole: 'main',
  windows: []
}

const get = (): ReturnType<typeof useStore.getState> => useStore.getState()

describe('store: update slice', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('initial data', () => {
    expect(get()).toMatchObject({
      hydrated: false,
      updateStatus: null,
      popupSnoozedVersion: null,
      restartConfirmOpen: false,
      installState: { kind: 'idle' },
      settingsInitialTab: undefined
    })
  })

  describe('hydrated gating of updateStatusChanged', () => {
    it('ignores the event before hydrate', () => {
      get().applyEvent({ type: 'updateStatusChanged', status: status() })
      expect(get().updateStatus).toBeNull()
    })
    it('applies it after hydrate', () => {
      get().hydrate(wsState)
      get().applyEvent({ type: 'updateStatusChanged', status: status() })
      expect(get().updateStatus).toEqual(status())
    })
    it('reduceEvent is pure on the data flag', () => {
      expect(
        reduceEvent(initialData(), { type: 'updateStatusChanged', status: status() }).updateStatus
      ).toBeNull()
      expect(
        reduceEvent(
          { ...initialData(), hydrated: true },
          { type: 'updateStatusChanged', status: status() }
        ).updateStatus
      ).toEqual(status())
    })
  })

  describe('hydrate carry-through', () => {
    it('keeps update state and settings tab across a re-hydrate', () => {
      get().hydrate(wsState)
      useStore.setState({
        updateStatus: status(),
        popupSnoozedVersion: '1.2.0',
        updateChecking: true,
        restartConfirmOpen: true,
        restartConfirmVersion: '1.2.0',
        installState: { kind: 'error', message: 'x' },
        settingsOpen: true,
        settingsInitialTab: 'updates'
      })
      get().hydrate(wsState)
      expect(get()).toMatchObject({
        hydrated: true,
        updateStatus: status(),
        popupSnoozedVersion: '1.2.0',
        updateChecking: true,
        restartConfirmOpen: true,
        restartConfirmVersion: '1.2.0',
        installState: { kind: 'error', message: 'x' },
        settingsOpen: true,
        settingsInitialTab: 'updates'
      })
    })
  })

  describe('loadUpdateStatus', () => {
    it('seeds when null', async () => {
      vi.mocked(window.octopusAPI.updates.getStatus).mockResolvedValue(status())
      await get().loadUpdateStatus()
      expect(get().updateStatus).toEqual(status())
    })
    it('does not overwrite a newer event-delivered status', async () => {
      useStore.setState({ updateStatus: status({ availableVersion: '1.5.0' }) })
      vi.mocked(window.octopusAPI.updates.getStatus).mockResolvedValue(status())
      await get().loadUpdateStatus()
      expect(get().updateStatus?.availableVersion).toBe('1.5.0')
    })
  })

  describe('openSettings / closeSettings', () => {
    it('openSettings(tab) records the tab; no arg clears it; close resets', () => {
      get().openSettings('updates')
      expect(get()).toMatchObject({ settingsOpen: true, settingsInitialTab: 'updates' })
      get().openSettings()
      expect(get().settingsInitialTab).toBeUndefined()
      get().openSettings('updates')
      get().closeSettings()
      expect(get()).toMatchObject({ settingsOpen: false, settingsInitialTab: undefined })
    })
  })

  describe('checkForUpdates', () => {
    it('sets updateChecking while in flight and stores the result', async () => {
      let resolve!: (s: UpdateStatusDTO) => void
      vi.mocked(window.octopusAPI.updates.checkNow).mockReturnValue(
        new Promise((r) => (resolve = r))
      )
      const p = get().checkForUpdates()
      expect(get().updateChecking).toBe(true)
      await get().checkForUpdates() // second call is a no-op while checking
      expect(window.octopusAPI.updates.checkNow).toHaveBeenCalledTimes(1)
      resolve(status())
      await p
      expect(get().updateChecking).toBe(false)
      expect(get().updateStatus).toEqual(status())
    })
    it('failure toasts an error and clears the flag', async () => {
      vi.mocked(window.octopusAPI.updates.checkNow).mockRejectedValue(new Error('nope'))
      await get().checkForUpdates()
      expect(get().updateChecking).toBe(false)
      expect(get().toasts.some((t) => t.message.includes('nope'))).toBe(true)
    })
  })

  describe('restart confirm', () => {
    it('open snapshots the version and resets install state', () => {
      useStore.setState({ installState: { kind: 'error', message: 'old' } })
      get().openRestartConfirm('1.2.0')
      expect(get()).toMatchObject({
        restartConfirmOpen: true,
        restartConfirmVersion: '1.2.0',
        installState: { kind: 'idle' }
      })
    })
    it('close (Not now) snoozes that version for the popup', () => {
      get().openRestartConfirm('1.2.0')
      get().closeRestartConfirm()
      expect(get()).toMatchObject({
        restartConfirmOpen: false,
        restartConfirmVersion: null,
        popupSnoozedVersion: '1.2.0',
        installState: { kind: 'idle' }
      })
    })
    it('close is a no-op while installing', () => {
      get().openRestartConfirm('1.2.0')
      useStore.setState({ installState: { kind: 'installing' } })
      get().closeRestartConfirm()
      expect(get().restartConfirmOpen).toBe(true)
    })
    it('a mid-install status event does not retitle the confirm', () => {
      get().hydrate(wsState)
      get().openRestartConfirm('1.2.0')
      get().applyEvent({
        type: 'updateStatusChanged',
        status: status({ availableVersion: '1.9.0' })
      })
      expect(get().restartConfirmVersion).toBe('1.2.0')
    })
  })

  describe('installUpdate', () => {
    it('ok leaves state installing (app relaunches)', async () => {
      vi.mocked(window.octopusAPI.updates.install).mockResolvedValue({ ok: true })
      await get().installUpdate('1.2.0')
      expect(window.octopusAPI.updates.install).toHaveBeenCalledWith('1.2.0')
      expect(get().installState).toEqual({ kind: 'installing' })
    })
    it('{ok:false} becomes an error state', async () => {
      vi.mocked(window.octopusAPI.updates.install).mockResolvedValue({ ok: false, error: 'bad' })
      await get().installUpdate('1.2.0')
      expect(get().installState).toEqual({ kind: 'error', message: 'bad' })
    })
    it('a rejected call becomes an error state', async () => {
      vi.mocked(window.octopusAPI.updates.install).mockRejectedValue(new Error('ipc down'))
      await get().installUpdate('1.2.0')
      expect(get().installState).toEqual({ kind: 'error', message: 'ipc down' })
    })
    it('is ignored while already installing', async () => {
      useStore.setState({ installState: { kind: 'installing' } })
      await get().installUpdate('1.2.0')
      expect(window.octopusAPI.updates.install).not.toHaveBeenCalled()
    })
  })
})
