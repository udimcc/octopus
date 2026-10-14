import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StatusIcon } from './StatusIcon'

describe('<StatusIcon> (§5.4/§9.5)', () => {
  it('renders nothing for the `none` display level', () => {
    const { container } = render(<StatusIcon display="none" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('`working` is a rotating yellow part-circle labelled "Working"', () => {
    const { getByRole } = render(<StatusIcon display="working" />)
    const el = getByRole('img', { name: 'Working' })
    expect(el.querySelector('svg circle')).not.toBeNull()
    expect(el).toHaveClass('status-spin')
    expect(el.style.color).toBe('var(--status-thinking)')
  })

  it('`review` is a STATIC accent dot labelled "Ready for review" (no spin)', () => {
    const { getByRole } = render(<StatusIcon display="review" />)
    const el = getByRole('img', { name: 'Ready for review' })
    expect(el.textContent).toBe('●')
    expect(el).not.toHaveClass('status-spin')
  })

  it('`idle` is a hollow dot labelled "Idle"', () => {
    const { getByRole } = render(<StatusIcon display="idle" />)
    const el = getByRole('img', { name: 'Idle' })
    expect(el.textContent).toBe('○')
    expect(el).not.toHaveClass('status-spin')
  })

  it('`needsInput` is a triangle labelled "Needs input"', () => {
    const { getByRole } = render(<StatusIcon display="needsInput" />)
    const el = getByRole('img', { name: 'Needs input' })
    expect(el.textContent).toBe('▲')
  })

  it('defaults to 1.1em (30% above the old 0.85em); an explicit size wins', () => {
    const { getByRole, rerender } = render(<StatusIcon display="idle" />)
    expect(getByRole('img', { name: 'Idle' }).style.fontSize).toBe('1.1em')
    rerender(<StatusIcon display="idle" size={20} />)
    expect(getByRole('img', { name: 'Idle' }).style.fontSize).toBe('20px')
  })
})
