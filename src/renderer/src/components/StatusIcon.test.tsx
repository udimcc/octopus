import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StatusIcon } from './StatusIcon'

describe('<StatusIcon> (§5.4/§9.5)', () => {
  it('renders nothing for the `none` display level', () => {
    const { container } = render(<StatusIcon display="none" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('`working` is a pulsing blue dot labelled "Working"', () => {
    const { getByRole } = render(<StatusIcon display="working" />)
    const el = getByRole('img', { name: 'Working' })
    expect(el.textContent).toBe('●')
    expect(el).toHaveClass('status-pulse')
  })

  it('`review` is a STATIC accent dot labelled "Ready for review" (no pulse)', () => {
    const { getByRole } = render(<StatusIcon display="review" />)
    const el = getByRole('img', { name: 'Ready for review' })
    expect(el.textContent).toBe('●')
    // The static dot is what distinguishes "done, wants eyes" from "still working".
    expect(el).not.toHaveClass('status-pulse')
  })

  it('`idle` is a hollow dot labelled "Idle"', () => {
    const { getByRole } = render(<StatusIcon display="idle" />)
    const el = getByRole('img', { name: 'Idle' })
    expect(el.textContent).toBe('○')
    expect(el).not.toHaveClass('status-pulse')
  })

  it('`needsInput` is a triangle labelled "Needs input"', () => {
    const { getByRole } = render(<StatusIcon display="needsInput" />)
    const el = getByRole('img', { name: 'Needs input' })
    expect(el.textContent).toBe('▲')
  })
})
