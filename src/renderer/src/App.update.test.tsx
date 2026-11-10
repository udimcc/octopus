import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { installStubBridge } from './test-support/stub-bridge'
import { App } from './App'
import { useStore, initialData } from './store/store'
import type { UpdateStatusDTO, WindowedWorkspaceStateDTO, WindowRole } from '../../shared/dto'

const state = (role: WindowRole): WindowedWorkspaceStateDTO => ({
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
  thisWindowId: role === 'main' ? 'main' : 'w2',
  thisWindowRole: role,
  windows: []
})

const status: UpdateStatusDTO = {
  state: 'available',
  availableVersion: '1.2.0',
  currentVersion: '1.0.0',
  popup: true
}

describe('<App> self-update wiring', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  it('main window: seeds the status after hydrate and shows the popup', async () => {
    const bridge = installStubBridge({ state: state('main') })
    bridge.api.updates.getStatus = (() => Promise.resolve(status)) as never
    render(<App />)
    expect(await screen.findByRole('dialog', { name: 'Update available' })).toBeInTheDocument()
  })

  it('main window: a pushed updateStatusChanged event shows the popup after hydrate', async () => {
    const bridge = installStubBridge({ state: state('main') })
    render(<App />)
    await waitFor(() => expect(useStore.getState().hydrated).toBe(true))
    act(() => bridge.emit({ type: 'updateStatusChanged', status }))
    expect(await screen.findByRole('dialog', { name: 'Update available' })).toBeInTheDocument()
  })

  it.each(['secondary'] as const)(
    '%s window: no update modals even with a popup status',
    async (role) => {
      const bridge = installStubBridge({ state: state(role) })
      bridge.api.updates.getStatus = (() => Promise.resolve(status)) as never
      render(<App />)
      act(() => useStore.setState({ restartConfirmOpen: true, restartConfirmVersion: '1.2.0' }))
      await waitFor(() => expect(useStore.getState().updateStatus).not.toBeNull())
      expect(screen.queryByRole('dialog', { name: 'Update available' })).toBeNull()
      expect(screen.queryByRole('dialog', { name: 'Restart to update' })).toBeNull()
    }
  )

  it('main window: restart confirm replaces the popup when Install is clicked', async () => {
    installStubBridge({ state: state('main') })
    render(<App />)
    await waitFor(() => expect(useStore.getState().hydrated).toBe(true))
    act(() => useStore.setState({ updateStatus: status }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    expect(await screen.findByRole('dialog', { name: 'Restart to update' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Update available' })).toBeNull()
  })
})
