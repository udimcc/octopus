import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('<App>', () => {
  beforeEach(() => {
    // Stub the preload bridge (no Electron in the test environment).
    window.octopusAPI = { ping: vi.fn().mockResolvedValue('pong') }
  })

  it('renders the app title', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Octopus' })).toBeInTheDocument()
  })
})
