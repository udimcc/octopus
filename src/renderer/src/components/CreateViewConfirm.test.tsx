import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CreateViewConfirm } from './CreateViewConfirm'

describe('<CreateViewConfirm> (window-view feature, modal/overlay contract)', () => {
  it('renders the dialog with the task name, following the shared modal contract', () => {
    render(<CreateViewConfirm taskName="My Task" onClose={vi.fn()} onConfirm={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: 'New Window From Task' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('tabIndex', '-1')
    expect(screen.getByText('Open "My Task" in a new window?')).toBeInTheDocument()
  })

  it('clicking the backdrop closes without confirming', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<CreateViewConfirm taskName="T" onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('presentation'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('clicking inside the card does not close it (click stopped before reaching the backdrop)', () => {
    const onClose = vi.fn()
    render(<CreateViewConfirm taskName="T" onClose={onClose} onConfirm={vi.fn()} />)

    fireEvent.click(screen.getByRole('dialog', { name: 'New Window From Task' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('Cancel calls onClose, not onConfirm', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<CreateViewConfirm taskName="T" onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('"Open window" calls onConfirm, not onClose', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<CreateViewConfirm taskName="T" onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open window' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape on the card closes it', () => {
    const onClose = vi.fn()
    render(<CreateViewConfirm taskName="T" onClose={onClose} onConfirm={vi.fn()} />)

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'New Window From Task' }), {
      key: 'Escape'
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── Shared overlay contract (.claude/rules/modals-and-overlays.md): every key
  // typed in the dialog must be stopped before it reaches the window-level
  // shortcut listener (pattern mirrors NewTaskModal.test.tsx).
  it('stops a session-cycle chord (Ctrl+Shift+ArrowRight) typed in the dialog from reaching the window', () => {
    render(<CreateViewConfirm taskName="T" onClose={vi.fn()} onConfirm={vi.fn()} />)
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'New Window From Task' }), {
        code: 'ArrowRight',
        key: 'ArrowRight',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('stops a close-session chord (Ctrl+Shift+KeyW) typed in the dialog from reaching the window', () => {
    render(<CreateViewConfirm taskName="T" onClose={vi.fn()} onConfirm={vi.fn()} />)
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'New Window From Task' }), {
        code: 'KeyW',
        key: 'w',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('Escape typed in the dialog does not reach the window listener either', () => {
    render(<CreateViewConfirm taskName="T" onClose={vi.fn()} onConfirm={vi.fn()} />)
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'New Window From Task' }), {
        key: 'Escape',
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })
})
