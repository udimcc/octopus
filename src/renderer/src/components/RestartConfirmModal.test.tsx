import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RestartConfirmModal } from './RestartConfirmModal'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { WindowRole } from '../../../shared/dto'

function seed(over: Record<string, unknown> = {}, role: WindowRole = 'main'): void {
  useStore.setState({
    ...initialData(),
    windowRole: role,
    restartConfirmOpen: true,
    restartConfirmVersion: '1.2.0',
    ...over
  })
}

describe('<RestartConfirmModal>', () => {
  beforeEach(() => {
    installStubBridge()
  })

  it('renders the confirm with the snapshotted version', () => {
    seed()
    render(<RestartConfirmModal />)
    const dlg = screen.getByRole('dialog', { name: 'Restart to update' })
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    expect(dlg).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('Install 1.2.0?')).toBeInTheDocument()
    expect(screen.getByText('Octopus will restart after the install.')).toBeInTheDocument()
  })

  it.each([
    ['closed', { restartConfirmOpen: false }],
    ['no version', { restartConfirmVersion: null }]
  ])('renders nothing when %s', (_n, over) => {
    seed(over)
    render(<RestartConfirmModal />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['secondary', 'view'] as const)('renders nothing in a %s window', (role) => {
    seed({}, role)
    render(<RestartConfirmModal />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('OK calls updates.install(version) and shows Installing with disabled buttons', async () => {
    let resolve!: (v: { ok: true }) => void
    vi.mocked(window.octopusAPI.updates.install).mockReturnValue(new Promise((r) => (resolve = r)))
    seed()
    render(<RestartConfirmModal />)
    const ok = screen.getByRole('button', { name: 'OK' })
    ok.focus()
    fireEvent.click(ok)
    expect(window.octopusAPI.updates.install).toHaveBeenCalledWith('1.2.0')
    // Focus moved to the card before the buttons disabled (else it would drop to <body>).
    expect(screen.getByRole('dialog')).toHaveFocus()
    expect(await screen.findByText('Installing…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled()
    resolve({ ok: true })
  })

  it('Not now closes and snoozes the popup version', () => {
    seed()
    render(<RestartConfirmModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useStore.getState().popupSnoozedVersion).toBe('1.2.0')
  })

  it('Escape closes when idle; a backdrop click closes when idle', () => {
    seed()
    const { unmount } = render(<RestartConfirmModal />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(useStore.getState().restartConfirmOpen).toBe(false)
    unmount()
    seed()
    const r = render(<RestartConfirmModal />)
    fireEvent.click(r.container.firstElementChild as HTMLElement)
    expect(useStore.getState().restartConfirmOpen).toBe(false)
  })

  it('a click inside the card does not close it', () => {
    seed()
    render(<RestartConfirmModal />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(useStore.getState().restartConfirmOpen).toBe(true)
  })

  it('while installing, neither Escape nor a backdrop click closes it', () => {
    seed({ installState: { kind: 'installing' } })
    const { container } = render(<RestartConfirmModal />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(container.firstElementChild as HTMLElement)
    expect(useStore.getState().restartConfirmOpen).toBe(true)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows the error, then OK retries', async () => {
    vi.mocked(window.octopusAPI.updates.install).mockResolvedValueOnce({
      ok: false,
      error: 'disk full'
    })
    seed()
    render(<RestartConfirmModal />)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    expect(screen.getByRole('button', { name: 'OK' })).toBeEnabled()

    vi.mocked(window.octopusAPI.updates.install).mockResolvedValueOnce({ ok: true })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Installing…')
    expect(window.octopusAPI.updates.install).toHaveBeenCalledTimes(2)
  })

  it('error state: Not now closes and resets', async () => {
    seed({ installState: { kind: 'error', message: 'x' } })
    render(<RestartConfirmModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(useStore.getState()).toMatchObject({
      restartConfirmOpen: false,
      installState: { kind: 'idle' }
    })
  })

  it('keys typed in it never reach a window keydown listener (also while installing)', () => {
    for (const over of [{}, { installState: { kind: 'installing' } }]) {
      seed(over)
      const { unmount } = render(<RestartConfirmModal />)
      const spy = vi.fn()
      window.addEventListener('keydown', spy)
      try {
        const dlg = screen.getByRole('dialog')
        fireEvent.keyDown(dlg, {
          key: 'ArrowRight',
          code: 'ArrowRight',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true
        })
        fireEvent.keyDown(screen.getByRole('button', { name: 'OK' }), {
          key: 'w',
          code: 'KeyW',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true
        })
        expect(spy).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener('keydown', spy)
        unmount()
      }
    }
  })
})
