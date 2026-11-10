import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { UpdateAvailableModal } from './UpdateAvailableModal'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { UpdateStatusDTO, WindowRole } from '../../../shared/dto'

const status = (over: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO => ({
  state: 'available',
  availableVersion: '1.2.0',
  currentVersion: '1.0.0',
  popup: true,
  ...over
})

function seed(over: Record<string, unknown> = {}, role: WindowRole = 'main'): void {
  useStore.setState({ ...initialData(), windowRole: role, updateStatus: status(), ...over })
}

describe('<UpdateAvailableModal>', () => {
  beforeEach(() => {
    installStubBridge()
  })

  it('renders an aria-modal dialog titled with the version', () => {
    seed()
    render(<UpdateAvailableModal />)
    const dlg = screen.getByRole('dialog', { name: 'Update available' })
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    expect(dlg).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('New version 1.2.0 is available')).toBeInTheDocument()
  })

  it.each([
    ['popup false', { updateStatus: status({ popup: false }) }],
    ['no status', { updateStatus: null }],
    ['snoozed', { popupSnoozedVersion: '1.2.0' }],
    ['restart confirm open', { restartConfirmOpen: true }]
  ])('renders nothing when %s', (_n, over) => {
    seed(over)
    render(<UpdateAvailableModal />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['secondary', 'view'] as const)('is not shown in a %s window', (role) => {
    seed({}, role)
    render(<UpdateAvailableModal />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Dismiss calls updates.dismiss(version)', () => {
    seed()
    render(<UpdateAvailableModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(window.octopusAPI.updates.dismiss).toHaveBeenCalledWith('1.2.0')
  })

  it('Escape dismisses', () => {
    seed()
    render(<UpdateAvailableModal />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(window.octopusAPI.updates.dismiss).toHaveBeenCalledWith('1.2.0')
  })

  it('a backdrop click does nothing', () => {
    seed()
    const { container } = render(<UpdateAvailableModal />)
    fireEvent.click(container.firstElementChild as HTMLElement)
    fireEvent.click(screen.getByRole('dialog'))
    expect(window.octopusAPI.updates.dismiss).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('Install opens the restart confirm for that version and hides the popup', () => {
    seed()
    render(<UpdateAvailableModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(useStore.getState()).toMatchObject({
      restartConfirmOpen: true,
      restartConfirmVersion: '1.2.0'
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hides when main republishes the status with popup=false', () => {
    seed()
    render(<UpdateAvailableModal />)
    act(() =>
      useStore.setState({ updateStatus: status({ popup: false, dismissedVersion: '1.2.0' }) })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a failed dismiss pushes an error toast', async () => {
    seed()
    vi.mocked(window.octopusAPI.updates.dismiss).mockRejectedValue(new Error('ipc'))
    render(<UpdateAvailableModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() =>
      expect(useStore.getState().toasts.some((t) => t.message.includes("Couldn't dismiss"))).toBe(
        true
      )
    )
  })

  it('takes focus when it is the topmost dialog', () => {
    seed()
    render(<UpdateAvailableModal />)
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('keys typed in it never reach a window keydown listener', () => {
    seed()
    render(<UpdateAvailableModal />)
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      const dlg = screen.getByRole('dialog')
      for (const init of [
        { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true },
        { key: 'w', code: 'KeyW', ctrlKey: true, shiftKey: true },
        { key: 'a', code: 'KeyA' }
      ]) {
        fireEvent.keyDown(dlg, { ...init, bubbles: true })
        fireEvent.keyDown(screen.getByRole('button', { name: 'Install' }), {
          ...init,
          bubbles: true
        })
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })
})
