import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Toaster } from './Toaster'
import { useStore, initialData } from '../store/store'

describe('<Toaster>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders queued toasts with the right role per kind', () => {
    act(() => {
      useStore.getState().pushToast('error', 'boom')
      useStore.getState().pushToast('info', 'heads up')
    })
    render(<Toaster />)
    expect(screen.getByText('boom').closest('[role="alert"]')).not.toBeNull()
    expect(screen.getByText('heads up').closest('[role="status"]')).not.toBeNull()
  })

  it('renders a bold title above the body, with a green info "i" icon', () => {
    act(() =>
      useStore.setState({
        toasts: [{ id: 1, kind: 'info', title: 'State changed', message: 'Refactor auth - claude' }]
      })
    )
    render(<Toaster />)
    const title = screen.getByText('State changed')
    expect(title).toBeInTheDocument()
    expect(getComputedStyle(title).fontWeight).toBe('700')
    // The body is a separate node from the title.
    expect(screen.getByText('Refactor auth - claude')).toBeInTheDocument()
    // The info badge glyph is present (aria-hidden, so query by text).
    expect(screen.getByText('i')).toBeInTheDocument()
  })

  it('dismisses a toast when its × is clicked', () => {
    act(() => useStore.getState().pushToast('info', 'closable'))
    render(<Toaster />)
    expect(screen.getByText('closable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }))
    expect(screen.queryByText('closable')).not.toBeInTheDocument()
  })

  it('auto-dismisses a toast after its timeout', () => {
    vi.useFakeTimers()
    act(() => useStore.getState().pushToast('info', 'ephemeral'))
    render(<Toaster />)
    expect(screen.getByText('ephemeral')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.queryByText('ephemeral')).not.toBeInTheDocument()
  })
})
