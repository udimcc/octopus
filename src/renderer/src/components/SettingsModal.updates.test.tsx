import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { UpdateStatusDTO } from '../../../shared/dto'

const status = (over: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO => ({
  state: 'upToDate',
  currentVersion: '1.0.0',
  popup: false,
  ...over
})

function open(s: UpdateStatusDTO | null): void {
  useStore.setState({ ...initialData(), updateStatus: s, settingsInitialTab: 'updates' })
  render(<SettingsModal onClose={vi.fn()} />)
}

describe('<SettingsModal> Check for updates tab', () => {
  beforeEach(() => {
    installStubBridge()
  })

  it('opens on the updates tab when requested', () => {
    open(status())
    expect(screen.getByRole('tab', { name: 'Check for updates' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tabpanel', { name: 'Check for updates' })).toBeInTheDocument()
  })

  it('can be reached by clicking the tab', () => {
    useStore.setState({ ...initialData(), updateStatus: status() })
    render(<SettingsModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Check for updates' }))
    expect(screen.getByText('Installed version: 1.0.0')).toBeInTheDocument()
  })

  it('upToDate: message, not-checked-yet, no Install', () => {
    open(status())
    expect(screen.getByText('Octopus is up to date.')).toBeInTheDocument()
    expect(screen.getByText('Not checked yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
  })

  it('shows Last checked when a time is known', () => {
    open(status({ lastCheckedAt: Date.now() }))
    expect(screen.getByText(/^Last checked \d{2}:\d{2}$/)).toBeInTheDocument()
  })

  it('available: shows versions and an enabled Install that opens the confirm', () => {
    open(status({ state: 'available', availableVersion: '1.2.0' }))
    expect(screen.getByText('Available version: 1.2.0')).toBeInTheDocument()
    expect(screen.getByText('Version 1.2.0 is available.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(useStore.getState()).toMatchObject({
      restartConfirmOpen: true,
      restartConfirmVersion: '1.2.0'
    })
  })

  it('unreachable with stale available: alert, version shown, Install disabled', () => {
    open(status({ state: 'unreachable', availableVersion: '1.2.0' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/unreachable/)
    expect(screen.getByRole('alert')).toHaveTextContent(/The version above was found earlier/)
    expect(screen.getByText('Available version: 1.2.0')).toBeInTheDocument()
    const install = screen.getByRole('button', { name: 'Install' })
    expect(install).toBeDisabled()
    expect(install).toHaveAttribute('title', 'The update folder is unreachable')
    fireEvent.click(install)
    expect(useStore.getState().restartConfirmOpen).toBe(false)
  })

  it('unreachable with nothing known: alert and no Install', () => {
    open(status({ state: 'unreachable' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('alert')).not.toHaveTextContent(/found earlier/)
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('Check now calls checkNow and updates the shown status', async () => {
    vi.mocked(window.octopusAPI.updates.checkNow).mockResolvedValue(
      status({ state: 'available', availableVersion: '1.3.0', popup: true })
    )
    open(status())
    const btn = screen.getByRole('button', { name: 'Check now' })
    btn.focus()
    fireEvent.click(btn)
    // Focus moved to the card before the button disabled (else it would drop to <body>).
    expect(screen.getByRole('dialog')).toHaveFocus()
    expect(window.octopusAPI.updates.checkNow).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Version 1.3.0 is available.')).toBeInTheDocument()
  })

  it('while checking the button reads Checking… and is disabled', () => {
    open(status())
    act(() => useStore.setState({ updateChecking: true }))
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
  })

  it('null status shows unknown version', () => {
    open(null)
    expect(screen.getByText('Installed version: unknown')).toBeInTheDocument()
  })
})
