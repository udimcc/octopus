import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { OctopusAPI } from '../../shared/ipc'
import { App } from './App'

/** A no-op stub of the full preload bridge (no Electron in the test env). */
function stubOctopusAPI(activeTaskId: string | undefined = undefined): OctopusAPI {
  const ack = vi.fn().mockResolvedValue({ ok: true })
  return {
    ping: vi.fn().mockResolvedValue('pong'),
    tasks: { create: ack, delete: ack, rename: ack, reorder: ack, switch: ack },
    sessions: {
      create: ack,
      close: ack,
      switch: ack,
      rename: ack,
      reorder: ack,
      move: ack,
      cwd: vi.fn().mockResolvedValue(null),
      refreshState: vi.fn()
    },
    windows: {
      create: ack,
      close: ack,
      createWithSession: ack,
      windowAtPoint: vi.fn().mockResolvedValue(null)
    },
    pty: { write: vi.fn(), resize: vi.fn() },
    app: {
      getState: vi.fn().mockResolvedValue({
        tasks: [],
        activeTaskId,
        sessionTypes: [],
        settings: {
          worktree: { location: '' },
          terminal: {},
          defaultSessionTypeId: 'terminal'
        },
        version: 1,
        thisWindowId: 'main',
        thisWindowRole: 'main',
        windows: []
      }),
      updateSettings: ack,
      getWindowId: vi.fn(() => 'main'),
      getVersion: vi.fn().mockResolvedValue('0.0.0-test')
    },
    dialog: { pickDirectory: vi.fn().mockResolvedValue(undefined) },
    clipboard: {
      read: vi.fn().mockResolvedValue(''),
      write: vi.fn().mockResolvedValue(undefined)
    },
    onEvent: vi.fn().mockReturnValue(() => undefined)
  }
}

describe('<App>', () => {
  beforeEach(() => {
    // Stub the preload bridge (no Electron in the test environment).
    window.octopusAPI = stubOctopusAPI()
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
    window.octopusAPI = stubOctopusAPI('task-1')
    render(<App />)
    await waitFor(() =>
      expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 'task-1' })
    )
    expect(window.octopusAPI.tasks.switch).toHaveBeenCalledTimes(1)
  })

  it('does not switch when there is no active task on launch', async () => {
    window.octopusAPI = stubOctopusAPI(undefined)
    render(<App />)
    // Let the getState promise settle before asserting the negative.
    await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())
    expect(window.octopusAPI.tasks.switch).not.toHaveBeenCalled()
  })
})
