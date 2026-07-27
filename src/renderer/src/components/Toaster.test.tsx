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
