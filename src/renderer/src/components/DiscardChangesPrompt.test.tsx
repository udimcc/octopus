import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DiscardChangesPrompt } from './DiscardChangesPrompt'

describe('<DiscardChangesPrompt> (Issues §13.5)', () => {
  it('renders "Discard unsaved changes?" with both actions', () => {
    render(<DiscardChangesPrompt onDiscard={vi.fn()} onKeepEditing={vi.fn()} />)
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('"Discard" calls onDiscard', () => {
    const onDiscard = vi.fn()
    render(<DiscardChangesPrompt onDiscard={onDiscard} onKeepEditing={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDiscard).toHaveBeenCalled()
  })

  it('"Keep editing" calls onKeepEditing', () => {
    const onKeepEditing = vi.fn()
    render(<DiscardChangesPrompt onDiscard={vi.fn()} onKeepEditing={onKeepEditing} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onKeepEditing).toHaveBeenCalled()
  })

  it('Escape on the dialog calls onKeepEditing', () => {
    const onKeepEditing = vi.fn()
    const onDiscard = vi.fn()
    render(<DiscardChangesPrompt onDiscard={onDiscard} onKeepEditing={onKeepEditing} />)
    const dialog = screen.getByRole('dialog', { name: 'Discard unsaved changes' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onKeepEditing).toHaveBeenCalled()
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('clicking the backdrop calls onKeepEditing', () => {
    const onKeepEditing = vi.fn()
    render(<DiscardChangesPrompt onDiscard={vi.fn()} onKeepEditing={onKeepEditing} />)
    fireEvent.click(screen.getByRole('presentation'))
    expect(onKeepEditing).toHaveBeenCalled()
  })
})
