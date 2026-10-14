import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { IssueStatusIcon } from './IssueStatusIcon'
import type { IssueStatusDTO } from '../../../shared/dto'

describe('<IssueStatusIcon> (Issues §13.1)', () => {
  it.each<[IssueStatusDTO, string]>([
    ['todo', 'Todo'],
    ['in_progress', 'In progress'],
    ['in_review', 'In review'],
    ['done', 'Done']
  ])('`%s` renders its own inline SVG labelled "%s"', (status, label) => {
    const { getByRole } = render(<IssueStatusIcon status={status} />)
    const el = getByRole('img', { name: label })
    expect(el).toHaveAttribute('title', label)
    expect(el).toHaveAttribute('data-status', status)
    const svg = el.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg!.childElementCount).toBeGreaterThan(0)
  })

  it('draws a different shape for every status', () => {
    const shapes = (['todo', 'in_progress', 'in_review', 'done'] as const).map((status) => {
      const { container } = render(<IssueStatusIcon status={status} />)
      return container.querySelector('svg')!.innerHTML
    })
    expect(new Set(shapes).size).toBe(4)
  })

  it('`size` sets the icon size in px; the SVG scales with it', () => {
    const { getByRole } = render(<IssueStatusIcon status="done" size={16} />)
    const el = getByRole('img', { name: 'Done' })
    expect(el.style.fontSize).toBe('16px')
    expect(el.querySelector('svg')).toHaveAttribute('width', '1em')
  })

  it('a custom `title` overrides the default status label in both aria-label and title', () => {
    const { getByRole } = render(<IssueStatusIcon status="done" title="My Issue Name" />)
    const el = getByRole('img', { name: 'My Issue Name' })
    expect(el).toHaveAttribute('title', 'My Issue Name')
    expect(el).toHaveAttribute('data-status', 'done')
  })
})
