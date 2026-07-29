import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { EditableLabel, type EditableLabelHandle } from './EditableLabel'

describe('<EditableLabel>', () => {
  it('shows the value as text until double-clicked', () => {
    render(<EditableLabel value="Alpha" onCommit={vi.fn()} editAriaLabel="rename task" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByLabelText('rename task')).not.toBeInTheDocument()
  })

  it('enters edit mode on double-click and commits a changed value on Enter', () => {
    const onCommit = vi.fn()
    render(<EditableLabel value="Alpha" onCommit={onCommit} editAriaLabel="rename task" />)
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByLabelText('rename task')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('Beta')
  })

  it('does not commit an unchanged value', () => {
    const onCommit = vi.fn()
    render(<EditableLabel value="Alpha" onCommit={onCommit} editAriaLabel="rename task" />)
    fireEvent.doubleClick(screen.getByText('Alpha'))
    fireEvent.keyDown(screen.getByLabelText('rename task'), { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not commit an empty (whitespace) value', () => {
    const onCommit = vi.fn()
    render(<EditableLabel value="Alpha" onCommit={onCommit} editAriaLabel="rename task" />)
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByLabelText('rename task')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('cancels the edit on Escape without committing', () => {
    const onCommit = vi.fn()
    render(<EditableLabel value="Alpha" onCommit={onCommit} editAriaLabel="rename task" />)
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByLabelText('rename task')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCommit).not.toHaveBeenCalled()
    // Back to display mode showing the original value.
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('cancels the edit on blur', () => {
    const onCommit = vi.fn()
    render(<EditableLabel value="Alpha" onCommit={onCommit} editAriaLabel="rename task" />)
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByLabelText('rename task')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('enters edit mode via the imperative beginEdit() handle', () => {
    const onCommit = vi.fn()
    const ref = createRef<EditableLabelHandle>()
    render(
      <EditableLabel ref={ref} value="Alpha" onCommit={onCommit} editAriaLabel="rename task" />
    )
    // No input until the parent asks to edit.
    expect(screen.queryByLabelText('rename task')).not.toBeInTheDocument()
    // beginEdit() sets state outside a React event, so flush it inside act().
    act(() => ref.current?.beginEdit())
    const input = screen.getByLabelText('rename task')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('Beta')
  })
})
