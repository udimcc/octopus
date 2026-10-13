import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { installStubBridge } from './test-support/stub-bridge'
import { App } from './App'
import type { WindowedWorkspaceStateDTO } from '../../shared/dto'

function state(activeTaskId: string | undefined): WindowedWorkspaceStateDTO {
  return {
    tasks: [],
    activeTaskId,
    sessionTypes: [],
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
}

describe('<App>', () => {
  beforeEach(() => {
    // Stub the preload bridge (no Electron in the test environment).
    installStubBridge({ state: state(undefined) })
  })

  it('renders the app title', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Octopus' })).toBeInTheDocument()
  })

  it('opens the New Task modal from the + New Task button', () => {
    render(<App />)
    expect(screen.queryByRole('dialog', { name: 'New Task' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ New Task' }))
    expect(screen.getByRole('dialog', { name: 'New Task' })).toBeInTheDocument()
  })

  it('triggers a mount-time switch to the hydrated active task (kicks off restore, §6.3)', async () => {
    installStubBridge({ state: state('task-1') })
    render(<App />)
    await waitFor(() =>
      expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 'task-1' })
    )
    expect(window.octopusAPI.tasks.switch).toHaveBeenCalledTimes(1)
  })

  it('does not switch when there is no active task on launch', async () => {
    installStubBridge({ state: state(undefined) })
    render(<App />)
    // Let the getState promise settle before asserting the negative.
    await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())
    expect(window.octopusAPI.tasks.switch).not.toHaveBeenCalled()
  })
})
