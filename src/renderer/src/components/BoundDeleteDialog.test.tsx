import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BoundDeleteDialog } from './BoundDeleteDialog'

describe('<BoundDeleteDialog> (Issues §13.1)', () => {
  it('renders the task/issue names and all four choices', () => {
    render(
      <BoundDeleteDialog
        taskName="Alpha"
        issueName="Fix bug"
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/"Alpha" is linked to issue "Fix bug"/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete task only' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete issue only' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete both' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('"Delete task only" calls onChoose with "task"', () => {
    const onChoose = vi.fn()
    render(<BoundDeleteDialog taskName="A" issueName="B" onChoose={onChoose} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete task only' }))
    expect(onChoose).toHaveBeenCalledWith('task')
  })

  it('"Delete issue only" calls onChoose with "issue"', () => {
    const onChoose = vi.fn()
    render(<BoundDeleteDialog taskName="A" issueName="B" onChoose={onChoose} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete issue only' }))
    expect(onChoose).toHaveBeenCalledWith('issue')
  })

  it('"Delete both" calls onChoose with "both"', () => {
    const onChoose = vi.fn()
    render(<BoundDeleteDialog taskName="A" issueName="B" onChoose={onChoose} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete both' }))
    expect(onChoose).toHaveBeenCalledWith('both')
  })

  it('Cancel calls onCancel', () => {
    const onCancel = vi.fn()
    render(<BoundDeleteDialog taskName="A" issueName="B" onChoose={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('Escape on the dialog calls onCancel', () => {
    const onCancel = vi.fn()
    render(<BoundDeleteDialog taskName="A" issueName="B" onChoose={vi.fn()} onCancel={onCancel} />)
    const dialog = screen.getByRole('dialog', { name: 'Delete linked task and issue' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('Escape does nothing while busy', () => {
    const onCancel = vi.fn()
    render(
      <BoundDeleteDialog taskName="A" issueName="B" onChoose={vi.fn()} onCancel={onCancel} busy />
    )
    const dialog = screen.getByRole('dialog', { name: 'Delete linked task and issue' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('shows an error message when provided', () => {
    render(
      <BoundDeleteDialog
        taskName="A"
        issueName="B"
        onChoose={vi.fn()}
        onCancel={vi.fn()}
        error="boom"
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })
})
