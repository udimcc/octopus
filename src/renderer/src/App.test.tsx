import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { OctopusAPI } from '../../shared/ipc'
import { App } from './App'

/** A no-op stub of the full preload bridge (no Electron in the test env). */
function stubOctopusAPI(): OctopusAPI {
  const ack = vi.fn().mockResolvedValue({ ok: true })
  return {
    ping: vi.fn().mockResolvedValue('pong'),
    tasks: { create: ack, delete: ack, rename: ack, reorder: ack, switch: ack },
    sessions: { create: ack, close: ack, rename: ack, reorder: ack },
    pty: { write: vi.fn(), resize: vi.fn() },
    app: {
      getState: vi.fn().mockResolvedValue({
        tasks: [],
        activeTaskId: undefined,
        sessionTypes: [],
        settings: {
          worktree: { location: '' },
          terminal: {},
          defaultSessionTypeId: 'terminal'
        },
        version: 1
      }),
      updateSettings: ack
    },
    dialog: { pickDirectory: vi.fn().mockResolvedValue(undefined) },
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
})
