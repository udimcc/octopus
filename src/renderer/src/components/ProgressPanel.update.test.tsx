import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProgressPanel } from './ProgressPanel'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { UpdateStatusDTO } from '../../../shared/dto'

const status = (over: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO => ({
  state: 'available',
  availableVersion: '1.2.0',
  currentVersion: '1.0.0',
  popup: false,
  ...over
})

describe('<ProgressPanel> update badge', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('shows a badge with tooltip "Update available: X" when available', () => {
    useStore.setState({ updateStatus: status() })
    render(<ProgressPanel onNewTask={() => {}} />)
    const b = screen.getByRole('button', { name: 'Update available: 1.2.0' })
    expect(b).toHaveAttribute('title', 'Update available: 1.2.0')
  })

  it('still shows (stale version) while unreachable', () => {
    useStore.setState({ updateStatus: status({ state: 'unreachable' }) })
    render(<ProgressPanel onNewTask={() => {}} />)
    expect(screen.getByRole('button', { name: 'Update available: 1.2.0' })).toBeInTheDocument()
  })

  it('is absent when up to date or status unknown', () => {
    useStore.setState({ updateStatus: status({ state: 'upToDate', availableVersion: undefined }) })
    const { unmount } = render(<ProgressPanel onNewTask={() => {}} />)
    expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull()
    unmount()
    useStore.setState({ updateStatus: null })
    render(<ProgressPanel onNewTask={() => {}} />)
    expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull()
  })

  it('is hidden in the read-only (view window) panel', () => {
    useStore.setState({ updateStatus: status() })
    render(<ProgressPanel onNewTask={() => {}} readOnly />)
    expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull()
  })

  it("click opens Settings on the 'updates' tab", () => {
    useStore.setState({ updateStatus: status() })
    render(<ProgressPanel onNewTask={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update available: 1.2.0' }))
    expect(useStore.getState()).toMatchObject({ settingsOpen: true, settingsInitialTab: 'updates' })
    expect(screen.getByRole('tab', { name: 'Check for updates' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('the plain settings button opens the default tab', () => {
    useStore.setState({ updateStatus: status() })
    render(<ProgressPanel onNewTask={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings' }))
    expect(useStore.getState().settingsInitialTab).toBeUndefined()
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
  })
})
