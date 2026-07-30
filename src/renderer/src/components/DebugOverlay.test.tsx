import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { DebugOverlay } from './DebugOverlay'
import { useStore, initialData, type DebugTransition } from '../store/store'

function seed(transitions: DebugTransition[], open: boolean): void {
  act(() => {
    useStore.setState({ ...initialData(), debugTransitions: transitions, debugOverlayOpen: open })
  })
}

const t = (over: Partial<DebugTransition> = {}): DebugTransition => ({
  seq: 1,
  sessionId: 'session-1',
  from: 'unknown',
  to: 'working',
  ...over
})

describe('<DebugOverlay>', () => {
  beforeEach(() => {
    act(() => useStore.setState(initialData()))
  })

  it('renders nothing when closed', () => {
    seed([t()], false)
    const { container } = render(<DebugOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('lists transitions newest-first with layer and reason when open', () => {
    seed(
      [
        t({ seq: 1, from: 'unknown', to: 'working', layer: 2, reason: 'osc_c' }),
        t({ seq: 2, from: 'working', to: 'waiting', layer: 3, reason: 'claude_stop' })
      ],
      true
    )
    render(<DebugOverlay />)
    expect(screen.getByLabelText('state detection debug overlay')).toBeInTheDocument()
    const items = screen.getAllByRole('listitem')
    // Newest (seq 2) is rendered first.
    expect(items[0]).toHaveTextContent('claude_stop')
    expect(items[0]).toHaveTextContent('L3')
    expect(items[1]).toHaveTextContent('osc_c')
    expect(items[1]).toHaveTextContent('L2')
  })

  it('shows an empty message when there are no transitions', () => {
    seed([], true)
    render(<DebugOverlay />)
    expect(screen.getByText('No transitions yet.')).toBeInTheDocument()
  })

  it('closes via the ✕ button (toggles the store flag)', () => {
    seed([t()], true)
    render(<DebugOverlay />)
    fireEvent.click(screen.getByRole('button', { name: 'close debug overlay' }))
    expect(useStore.getState().debugOverlayOpen).toBe(false)
  })
})
