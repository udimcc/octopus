import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { WorkspaceStateDTO } from '../../../shared/dto'

const seededState: WorkspaceStateDTO = {
  tasks: [],
  activeTaskId: undefined,
  sessionTypes: [],
  settings: {
    worktree: { location: '/repos' },
    terminal: { shell: '/bin/bash' },
    defaultSessionTypeId: 'terminal'
  },
  version: 1
}

describe('<SettingsModal>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    useStore.getState().hydrate(seededState)
  })

  it('prefills the current settings', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    expect(screen.getByLabelText('worktree location')).toHaveValue('/repos')
    expect(screen.getByLabelText('terminal shell')).toHaveValue('/bin/bash')
  })

  it('saves a patch and refetches state, then closes', async () => {
    const bridge = installStubBridge({ state: seededState })
    const onClose = vi.fn()
    render(<SettingsModal onClose={onClose} />)

    fireEvent.change(screen.getByLabelText('worktree location'), {
      target: { value: '/new/loc' }
    })
    fireEvent.change(screen.getByLabelText('terminal shell'), { target: { value: '/bin/zsh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith({
      worktree: { location: '/new/loc' },
      terminal: { shell: '/bin/zsh' }
    })
    // updateSettings emits nothing → the modal must refetch getState to reflect it.
    await waitFor(() => expect(bridge.api.app.getState).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('sends undefined shell when the shell field is cleared', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('terminal shell'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith({
      worktree: { location: '/repos' },
      terminal: { shell: undefined }
    })
  })

  it('surfaces a save error and stays open', async () => {
    installStubBridge({ ack: () => ({ ok: false, error: 'disk full' }), state: seededState })
    const onClose = vi.fn()
    render(<SettingsModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('disk full'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
